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
/// The wire format is shared with the TypeScript implementation
/// (<c>packages/identity/src/principal.ts</c>) and the Python one
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
public sealed record Principal(string Sub, string TenantId, string Audience, IReadOnlyList<string> Scopes)
{
    /// <summary>
    /// Org roles from the IdP (Keycloak realm roles). Init-only with an empty
    /// default so existing <c>new Principal(...)</c> call sites keep compiling
    /// and a role-less token — including the pinned cross-language fixture —
    /// round-trips unchanged.
    /// </summary>
    public IReadOnlyList<string> Roles { get; init; } = [];
}

/// <summary>Raised whenever a token cannot be trusted, for any reason.</summary>
public sealed class InvalidPrincipalException(string reason)
    : Exception($"Invalid principal token: {reason}");

/// <summary>Verifies and parses the principal the hub presents.</summary>
public static class Principals
{
    private static readonly HashSet<string> Audiences = ["internal", "external"];

    // Closed like the TypeScript RoleSchema enum: an unknown role value is a
    // malformed token, not one to accept leniently.
    private static readonly HashSet<string> KnownRoles =
        ["leadership", "engineering", "finance", "platform"];

    // The reference TypeScript `PrincipalSchema` is `.strict()`. Accepting an
    // unknown claim here would mean a token this satellite honours and orders
    // refuses — the two disagreeing about what a valid identity is, which is
    // the divergence the shared fixture test exists to catch.
    private static readonly HashSet<string> Claims =
        ["sub", "tenantId", "audience", "scopes", "roles"];

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
        // Emitted only when present, matching TypeScript's optional `roles`, so
        // a role-less principal round-trips to the same bytes.
        if (principal.Roles.Count > 0) claims["roles"] = principal.Roles;
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

        // Ordinal throughout: these names are wire tokens, not text for a reader, and
        // the default comparer would order them by the server's culture — Python's
        // `sorted()` and this would then disagree on the same message.
        var unknown = new SortedSet<string>(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var duplicated = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var property in decoded.EnumerateObject())
        {
            if (!Claims.Contains(property.Name)) unknown.Add(property.Name);
            if (!seen.Add(property.Name)) duplicated.Add(property.Name);
        }
        if (unknown.Count > 0)
        {
            throw new InvalidPrincipalException($"unknown claim(s): {string.Join(", ", unknown)}");
        }

        // A repeated claim is refused rather than resolved.
        //
        // Not because the three languages disagree — measured, they do not:
        // `TryGetProperty`, `JSON.parse` and `json.loads` all keep the *last*
        // occurrence, so a payload with two `tenantId` claims reads the same
        // everywhere today. This is deliberate extra strictness, and it is
        // worth being clear that it is: nothing that mints these can produce a
        // duplicate, because every implementation serialises from a map, so a
        // token carrying one did not come from the hub.
        //
        // The cost is a real if benign divergence — orders and fleet would
        // accept such a token and this refuses it. Fail-closed, and worth
        // porting to the other two rather than dropping here.
        if (duplicated.Count > 0)
        {
            throw new InvalidPrincipalException($"duplicate claim(s): {string.Join(", ", duplicated)}");
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

        // Optional and closed, mirroring the TypeScript enum: absent leaves an
        // empty role set; a present-but-unknown value fails the token.
        var roles = new List<string>();
        if (decoded.TryGetProperty("roles", out var rawRoles))
        {
            if (rawRoles.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidPrincipalException("payload is not a principal");
            }
            foreach (var role in rawRoles.EnumerateArray())
            {
                var value = role.ValueKind == JsonValueKind.String ? role.GetString() : null;
                if (value is null || !KnownRoles.Contains(value))
                {
                    throw new InvalidPrincipalException("payload is not a principal");
                }
                roles.Add(value);
            }
        }

        return new Principal(sub, tenantId, audience, scopes) { Roles = roles };
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
