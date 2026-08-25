using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace Satellite.Depots.Tests;

/// <summary>Hosts the real app in-process, with a known principal secret.</summary>
public sealed class DepotsApp : WebApplicationFactory<Program>
{
    public const string Secret = "integration-secret";

    protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
    {
        Environment.SetEnvironmentVariable("PORTAL_PRINCIPAL_SECRET", Secret);
        builder.UseSetting("PORTAL_PRINCIPAL_SECRET", Secret);
    }

    public HttpClient ClientFor(Principal principal)
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", Principals.SignPrincipal(principal, Secret));
        return client;
    }

    public static Principal Acme(params string[] scopes) =>
        // platform is one of depots' offered roles and the only role that may
        // close a depot, so the default probe clears both the satellite gate and
        // the close action's; override the record's Roles to test refusal.
        new("alice@acme.example", "acme", "internal", scopes.Length == 0 ? ["depots.read"] : scopes)
        {
            Roles = ["platform"],
        };

    public static Principal Globex(params string[] scopes) =>
        new("bob@globex.example", "globex", "internal", scopes.Length == 0 ? ["depots.read"] : scopes)
        {
            Roles = ["platform"],
        };
}

public class TheDoor(DepotsApp app) : IClassFixture<DepotsApp>
{
    // Screens, not the manifest. The manifest is deliberately public — see
    // `TheManifestIsPublic` below — so pointing these at it would assert the
    // opposite of the contract. They did, until `pnpm conformance` caught the
    // manifest requiring a token and these tests kept passing because every
    // one of them sent one.
    private const string Screen = "/portal/screens/depots.dashboard";

    [Fact]
    public async Task RefusesAnUnsignedRequest()
    {
        var response = await app.CreateClient().GetAsync(Screen);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task RefusesATokenSignedWithAnotherSecret()
    {
        var client = app.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(
            "Bearer", Principals.SignPrincipal(DepotsApp.Acme(), "not-the-secret"));

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(Screen)).StatusCode);
    }

    [Fact]
    public async Task AcceptsALowercaseBearerScheme()
    {
        // RFC 7235 says the scheme is case-insensitive. Reading `bearer` as
        // "no credentials" would refuse a legal request.
        var client = app.CreateClient();
        client.DefaultRequestHeaders.TryAddWithoutValidation(
            "Authorization", $"bearer {Principals.SignPrincipal(DepotsApp.Acme(), DepotsApp.Secret)}");

        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(Screen)).StatusCode);
    }

    [Fact]
    public async Task RefusesAnExternalPrincipal()
    {
        // The manifest declares [internal]. Default-deny is enforced here, not
        // assumed of the hub.
        var external = DepotsApp.Acme() with { Audience = "external" };
        var response = await app.ClientFor(external).GetAsync(Screen);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task RefusesAReadWithoutTheReadScope()
    {
        var response = await app.ClientFor(DepotsApp.Acme("depots.write")).GetAsync(Screen);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task RefusesAWriteWithOnlyTheReadScope()
    {
        var response = await app.ClientFor(DepotsApp.Acme("depots.read"))
            .PostAsJsonAsync("/portal/actions/depots.close", new { id = "dep-4", reason = "maintenance" });

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Theory]
    [InlineData("leadership")]
    [InlineData("engineering")]
    [InlineData("finance")]
    [InlineData("platform")]
    public async Task EveryOrgRoleMayReadTheSatellite(string role)
    {
        // This satellite declares no role ceiling: reaching it is not what
        // roles decide. Replaces a test asserting 403 for finance — that
        // assertion WAS the behaviour being fixed.
        var principal = DepotsApp.Acme("depots.read") with { Roles = [role] };
        var response = await app.ClientFor(principal).GetAsync(Screen);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task ARolelessPrincipalStillReadsTheSharedDashboard()
    {
        // Holding no role must not be the same as being refused: the shared
        // half of the screen belongs to everyone, and only the additions are
        // earned. Guards against reading "absent roles" as "nobody".
        var principal = DepotsApp.Acme("depots.read") with { Roles = [] };
        var response = await app.ClientFor(principal).GetAsync(Screen);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("depots-table", await response.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("finance", "depots-finance-chart")]
    [InlineData("platform", "depots-platform-metrics")]
    [InlineData("engineering", "depots-capacity-pressure")]
    public async Task ARoleSeesItsOwnSectionAndNoOneElseSees(string role, string nodeId)
    {
        var holder = DepotsApp.Acme("depots.read") with { Roles = [role] };
        var body = await (await app.ClientFor(holder).GetAsync(Screen)).Content.ReadAsStringAsync();
        Assert.Contains(nodeId, body);

        foreach (var other in new[] { "leadership", "engineering", "finance", "platform" })
        {
            if (other == role) continue;
            var stranger = DepotsApp.Acme("depots.read") with { Roles = [other] };
            var strangerBody =
                await (await app.ClientFor(stranger).GetAsync(Screen)).Content.ReadAsStringAsync();
            Assert.DoesNotContain(nodeId, strangerBody);
        }
    }

    [Fact]
    public async Task RoleSectionsAddAndNeverReplace()
    {
        // The point of the change. Whatever a role holds, the shared table
        // every role had is still on the screen. A regression here means an
        // addition was turned into a substitution.
        foreach (var roles in new[]
        {
            Array.Empty<string>(),
            ["finance"],
            ["engineering"],
            ["platform"],
            new[] { "finance", "engineering", "platform" },
        })
        {
            var principal = DepotsApp.Acme("depots.read") with { Roles = roles };
            var body = await (await app.ClientFor(principal).GetAsync(Screen)).Content.ReadAsStringAsync();
            Assert.Contains("depots-table", body);
        }
    }

    [Fact]
    public async Task RefusesCloseFromANonPlatformRole()
    {
        // Closing is platform-only; leadership may see depots but not close one.
        var leadership = DepotsApp.Acme("depots.read", "depots.write") with { Roles = ["leadership"] };
        var response = await app.ClientFor(leadership)
            .PostAsJsonAsync("/portal/actions/depots.close", new { id = "dep-4", reason = "maintenance" });
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }
}

public class TheManifestIsPublic(DepotsApp app) : IClassFixture<DepotsApp>
{
    /// <summary>
    /// The declaration is not tenant data, and the hub reads it at boot —
    /// before any user has arrived, so before it has a principal to present.
    /// The other two satellites already served it unauthenticated; this one
    /// did not, and `pnpm conformance` is what said so.
    /// </summary>
    [Fact]
    public async Task ServesTheDeclarationWithoutCredentials()
    {
        var response = await app.CreateClient().GetAsync("/portal/manifest");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("depots", body.GetProperty("satelliteId").GetString());
    }

    [Fact]
    public async Task CarriesNoTenantDataToLeak()
    {
        // The reason it is safe to serve unauthenticated: ids, titles and nav
        // placement, and nothing belonging to anybody.
        var body = await (await app.CreateClient().GetAsync("/portal/manifest"))
            .Content.ReadAsStringAsync();

        Assert.DoesNotContain("Zürich", body);
        Assert.DoesNotContain("acme", body);
        Assert.DoesNotContain("globex", body);
    }
}

public class TenantIsolation(DepotsApp app) : IClassFixture<DepotsApp>
{
    /// <summary>
    /// The test PLAN.md calls the one that proves authorization is not
    /// hub-dependent: call the satellite directly, with one tenant's token,
    /// for another tenant's record.
    /// </summary>
    [Fact]
    public async Task DoesNotReturnAnotherTenantsDepot()
    {
        // `dep-9` belongs to globex. Asked for by an acme principal, going
        // straight to the satellite with no hub involved.
        var response = await app.ClientFor(DepotsApp.Acme())
            .GetAsync("/portal/screens/depots.detail?id=dep-9");

        // 404, not 403: a 403 would confirm the id exists somewhere else.
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task ListsOnlyTheCallingTenantsDepots()
    {
        var body = await (await app.ClientFor(DepotsApp.Acme())
            .GetAsync("/portal/screens/depots.dashboard")).Content.ReadAsStringAsync();

        Assert.Contains("Zürich Central", body);
        Assert.DoesNotContain("Osaka Bay", body);
    }

    [Fact]
    public async Task TenantsHaveDisjointDashboards()
    {
        var acme = await (await app.ClientFor(DepotsApp.Acme())
            .GetAsync("/portal/screens/depots.dashboard")).Content.ReadAsStringAsync();
        var globex = await (await app.ClientFor(DepotsApp.Globex())
            .GetAsync("/portal/screens/depots.dashboard")).Content.ReadAsStringAsync();

        Assert.Contains("Osaka Bay", globex);
        Assert.DoesNotContain("Osaka Bay", acme);
        Assert.DoesNotContain("Zürich Central", globex);
    }

    [Fact]
    public async Task WillNotCloseAnotherTenantsDepot()
    {
        var response = await app.ClientFor(DepotsApp.Globex("depots.read", "depots.write"))
            .PostAsJsonAsync("/portal/actions/depots.close", new { id = "dep-5", reason = "maintenance" });

        var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("error", body.GetProperty("outcome").GetString());

        // Refusing and not-mutating are separate claims: a handler that wrote
        // first and checked the tenant afterwards would pass the assertion
        // above and still have closed acme's depot.
        var acme = await (await app.ClientFor(DepotsApp.Acme())
            .GetAsync("/portal/screens/depots.detail?id=dep-5")).Content.ReadAsStringAsync();
        Assert.Contains("\"value\":\"open\"", acme.Replace(" ", ""));
    }
}

public class TheActionRoundTrip(DepotsApp app) : IClassFixture<DepotsApp>
{
    private static async Task<JsonElement> Post(HttpClient client, object body) =>
        JsonDocument.Parse(
            await (await client.PostAsJsonAsync("/portal/actions/depots.close", body))
                .Content.ReadAsStringAsync()).RootElement;

    [Fact]
    public async Task NamesTheFieldWhenSomethingIsMissing()
    {
        var body = await Post(app.ClientFor(DepotsApp.Acme("depots.read", "depots.write")), new { id = "dep-4" });

        Assert.Equal("validation", body.GetProperty("outcome").GetString());
        Assert.True(body.GetProperty("fieldErrors").TryGetProperty("reason", out _));
    }

    [Fact]
    public async Task RefusesToCloseADepotThatStillHoldsStock()
    {
        // A validation outcome rather than a failure: the user can act on it.
        var body = await Post(
            app.ClientFor(DepotsApp.Acme("depots.read", "depots.write")),
            new { id = "dep-2", reason = "maintenance" });

        Assert.Equal("validation", body.GetProperty("outcome").GetString());
        Assert.Contains("pallets", body.GetProperty("fieldErrors").GetProperty("id").GetString());
    }

    [Fact]
    public async Task ClosesADepotAndSendsTheCallerBackToTheDashboard()
    {
        // Navigate, not patch: the form that reaches this action lives only on
        // `depots.detail`, which has no `depots-table` node, so a patch
        // addressing one would be refused by the hub and pair a success toast
        // with a screen that never changed.
        var client = app.ClientFor(DepotsApp.Acme("depots.read", "depots.write"));
        var body = await Post(client, new { id = "dep-5", reason = "lease-ended" });

        Assert.Equal("ok", body.GetProperty("outcome").GetString());
        Assert.False(body.TryGetProperty("patch", out _));
        Assert.Equal("depots.dashboard", body.GetProperty("navigate").GetProperty("screenId").GetString());

        // And it actually persisted. Asserting only on the envelope would pass
        // against a repository whose write silently went nowhere.
        var detail = await (await client.GetAsync("/portal/screens/depots.detail?id=dep-5"))
            .Content.ReadAsStringAsync();
        Assert.Contains("\"value\":\"closed\"", detail.Replace(" ", ""));
    }

    [Fact]
    public async Task AnswersAnUnreadableBodyWithFieldErrorsRatherThan500()
    {
        // `ReadFromJsonAsync` throws `InvalidOperationException` when there is
        // no JSON content type, which escaped the handler's `JsonException`
        // catch as a 500. `express.json()` in the orders satellite degrades to
        // `{}` here, so a 500 was also a cross-language divergence.
        var response = await app.ClientFor(DepotsApp.Acme("depots.read", "depots.write"))
            .PostAsync("/portal/actions/depots.close", new StringContent("id=dep-4", Encoding.UTF8, "text/plain"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("validation", body.GetProperty("outcome").GetString());
    }
}
