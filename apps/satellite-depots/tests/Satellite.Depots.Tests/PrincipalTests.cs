using Satellite.Depots;
using Xunit;

namespace Satellite.Depots.Tests;

public class VerifyingAPrincipal
{
    private const string Secret = "test-secret";

    private static Principal Alice => new("alice@acme.example", "acme", "internal", ["depots.read"]);

    [Fact]
    public void AcceptsATokenItMinted()
    {
        var principal = Principals.Verify(Principals.SignPrincipal(Alice, Secret), Secret);
        Assert.Equal("acme", principal.TenantId);
        Assert.Equal(["depots.read"], principal.Scopes);
    }

    [Fact]
    public void RefusesAnotherSecretsSignature()
    {
        var token = Principals.SignPrincipal(Alice, "a-different-secret");
        Assert.Throws<InvalidPrincipalException>(() => Principals.Verify(token, Secret));
    }

    [Fact]
    public void RefusesATamperedPayload()
    {
        // The whole point: edit the tenant and the signature stops matching.
        var token = Principals.SignPrincipal(Alice, Secret);
        var forged = Principals.SignPrincipal(Alice with { TenantId = "globex" }, Secret);
        var swapped = $"{forged.Split('.')[0]}.{token.Split('.')[1]}";

        Assert.Throws<InvalidPrincipalException>(() => Principals.Verify(swapped, Secret));
    }

    [Theory]
    [InlineData("")]
    [InlineData("nodot")]
    [InlineData("a.b.c")]
    [InlineData(".signature")]
    [InlineData("payload.")]
    public void RefusesAMalformedToken(string token) =>
        Assert.Throws<InvalidPrincipalException>(() => Principals.Verify(token, Secret));

    [Fact]
    public void RefusesAnUnknownClaim()
    {
        // `PrincipalSchema` is `.strict()`. A satellite that accepted extra
        // claims would honour tokens another satellite refuses, and the two
        // would disagree about what a valid identity is.
        var payload = System.Convert.ToBase64String(
                System.Text.Encoding.UTF8.GetBytes(
                    """{"sub":"a","tenantId":"t","audience":"internal","scopes":[],"admin":true}"""))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        using var hmac = new System.Security.Cryptography.HMACSHA256(
            System.Text.Encoding.UTF8.GetBytes(Secret));
        var signature = System.Convert.ToBase64String(
                hmac.ComputeHash(System.Text.Encoding.UTF8.GetBytes(payload)))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');

        var error = Assert.Throws<InvalidPrincipalException>(
            () => Principals.Verify($"{payload}.{signature}", Secret));
        Assert.Contains("admin", error.Message);
    }
}

public class TheCrossLanguageContract
{
    /// <summary>
    /// The polyglot claim is only real if the wire format actually crosses.
    /// </summary>
    /// <remarks>
    /// This exact token and secret appear in the Python satellite's
    /// <c>TestCrossLanguageContract</c>, and it was minted by the TypeScript
    /// implementation. Three languages now verify one fixture: if any of them
    /// changes how it signs or parses, this fails rather than the satellites
    /// silently ceasing to speak the same protocol — which no single-language
    /// test could catch.
    /// </remarks>
    private const string Secret = "cross-language-fixture";

    private const string Token =
        "eyJzdWIiOiJkYW5hQGFjbWUuZXhhbXBsZSIsInRlbmFudElkIjoiYWNtZSIsImF1ZGllbmNlIjoi"
        + "aW50ZXJuYWwiLCJzY29wZXMiOlsiZmxlZXQucmVhZCJdfQ"
        + ".rSTY_1hMvKQ4VQkFl21Ei26LRebW6RbGcxYaz5Bd2iU";

    [Fact]
    public void VerifiesATokenMintedByTheTypeScriptSatellite()
    {
        var principal = Principals.Verify(Token, Secret);

        Assert.Equal("dana@acme.example", principal.Sub);
        Assert.Equal("acme", principal.TenantId);
        Assert.Equal("internal", principal.Audience);
        Assert.Equal(["fleet.read"], principal.Scopes);
    }

    [Fact]
    public void RefusesThatTokenUnderAnyOtherSecret() =>
        Assert.Throws<InvalidPrincipalException>(() => Principals.Verify(Token, "not-the-secret"));
}
