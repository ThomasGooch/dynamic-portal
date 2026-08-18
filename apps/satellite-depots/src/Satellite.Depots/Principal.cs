using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Satellite.Depots;

/// <summary>
/// Principal verification. The satellite verifies the identity it is handed;
/// it does not trust the hub.
/// </summary>
/// <remarks>
/// This is the architecture's central security claim: authorization lives in
/// the satellite, so a hub bug is an availability incident rather than a
/// cross-tenant disclosure. That is only true if the satellite actually checks
/// the signature.
///
/// The wire format is shared with the TypeScript satellite
/// (<c>apps/satellite-orders/src/principal.ts</c>) and the Python one
/// (<c>apps/satellite-fleet/src/satellite_fleet/principal.py</c>):
/// base64url(JSON) <c>.</c> base64url(HMAC-SHA256).
///
/// Verification runs over the <em>received</em> payload string and never
/// re-serialises it. JSON key order differs between languages, and
/// re-encoding before comparing would break every cross-language token — the
/// third implementation of this is exactly where that mistake would surface.
///
/// The prototype uses a shared HMAC secret. Production swaps this for
/// verifying an RFC 8693 exchanged token against the issuer's JWKS; the
/// <see cref="Principal"/> shape and the call sites do not change.
/// </remarks>
public sealed record Principal(string Sub, string TenantId, string Audience, IReadOnlyList<string> Scopes);

/// <summary>Raised whenever a token cannot be trusted, for any reason.</summary>
public sealed class InvalidPrincipalException(string reason)
    : Exception($"Invalid principal token: {reason}");

/// <summary>Verifies and parses the principal the hub presents.</summary>
public static class Principals
{
    private static readonly HashSet<string> Audiences = ["internal", "external"];

    // The reference TypeScript `PrincipalSchema` is `.strict()`. Accepting an
    // unknown claim here would mean a token this satellite honours and orders
    // refuses — the two disagreeing about what a valid identity is, which is
    // the divergence the shared fixture test exists to catch.
    private static readonly HashSet<string> Claims = ["sub", "tenantId", "audience", "scopes"];

    private static string Base64UrlEncode(byte[] raw) =>
        Convert.ToBase64String(raw).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] Base64UrlDecode(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        padded += new string('=', (4 - (padded.Length % 4)) % 4);
        return Convert.FromBase64String(padded);
    }

    private static string Sign(string payload, string secret)
    {
        // UTF-8 on both sides: the payload comes straight off the wire and may
        // carry bytes above 0x7F, and Node's `hmac.update(string)` defaults to
        // utf-8. An ASCII encoding here would silently produce a different
        // digest for exactly those tokens.
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        return Base64UrlEncode(hmac.ComputeHash(Encoding.UTF8.GetBytes(payload)));
    }

    /// <summary>Mints a token. Used by tests and by nothing in the request path.</summary>
    public static string SignPrincipal(Principal principal, string secret)
    {
        // Key order matches the TypeScript object literal. It does not have to
        // for verification — that reads the received string — but a token this
        // mints should look like one the hub mints.
        var claims = new Dictionary<string, object>
        {
            ["sub"] = principal.Sub,
            ["tenantId"] = principal.TenantId,
            ["audience"] = principal.Audience,
            ["scopes"] = principal.Scopes,
        };
        var payload = Base64UrlEncode(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(claims, PortalJsonOptions.Compact)));
        return $"{payload}.{Sign(payload, secret)}";
    }

    /// <summary>Verifies a token, or throws.</summary>
    public static Principal Verify(string token, string secret)
    {
        var parts = token.Split('.');
        if (parts.Length != 2) throw new InvalidPrincipalException("expected <payload>.<signature>");

        var (payload, signature) = (parts[0], parts[1]);
        if (payload.Length == 0 || signature.Length == 0)
        {
            throw new InvalidPrincipalException("empty segment");
        }

        // Constant-time, over the payload exactly as received, compared as
        // bytes — the signature segment is attacker-controlled and may not be
        // ASCII.
        var expected = Encoding.UTF8.GetBytes(Sign(payload, secret));
        var actual = Encoding.UTF8.GetBytes(signature);
        if (expected.Length != actual.Length || !CryptographicOperations.FixedTimeEquals(expected, actual))
        {
            throw new InvalidPrincipalException("signature mismatch");
        }

        JsonElement decoded;
        try
        {
            decoded = JsonSerializer.Deserialize<JsonElement>(Base64UrlDecode(payload));
        }
        catch (Exception exception) when (exception is FormatException or JsonException)
        {
            throw new InvalidPrincipalException("payload is not JSON");
        }

        return ParseClaims(decoded);
    }

    private static Principal ParseClaims(JsonElement decoded)
    {
        if (decoded.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidPrincipalException("payload is not an object");
        }

        var unknown = decoded.EnumerateObject()
            .Select(property => property.Name)
            .Where(name => !Claims.Contains(name))
            .Order()
            .ToList();
        if (unknown.Count > 0)
        {
            throw new InvalidPrincipalException($"unknown claim(s): {string.Join(", ", unknown)}");
        }

        var sub = Text(decoded, "sub");
        var tenantId = Text(decoded, "tenantId");
        var audience = Text(decoded, "audience");

        if (sub is null or "" || tenantId is null or "" || audience is null || !Audiences.Contains(audience))
        {
            throw new InvalidPrincipalException("payload is not a principal");
        }

        if (!decoded.TryGetProperty("scopes", out var rawScopes) || rawScopes.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidPrincipalException("payload is not a principal");
        }

        var scopes = new List<string>();
        foreach (var scope in rawScopes.EnumerateArray())
        {
            if (scope.ValueKind != JsonValueKind.String || scope.GetString() is null or "")
            {
                throw new InvalidPrincipalException("payload is not a principal");
            }
            scopes.Add(scope.GetString()!);
        }

        return new Principal(sub, tenantId, audience, scopes);
    }

    private static string? Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}

/// <summary>Serialiser settings shared by the satellite's own payloads.</summary>
internal static class PortalJsonOptions
{
    public static readonly JsonSerializerOptions Compact = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };
}
