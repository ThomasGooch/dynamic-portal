using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
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
        new("alice@acme.example", "acme", "internal", scopes.Length == 0 ? ["depots.read"] : scopes);

    public static Principal Globex(params string[] scopes) =>
        new("bob@globex.example", "globex", "internal", scopes.Length == 0 ? ["depots.read"] : scopes);
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
            .PostAsJsonAsync("/portal/actions/depots.close", new { id = "dep-4", reason = "maintenance" });

        var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("error", body.GetProperty("outcome").GetString());
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
    public async Task ClosesAnEmptyDepotAndPatchesTheTable()
    {
        // The hypermedia claim: the satellite says what should now be true and
        // the hub applies it. No satellite JavaScript is involved.
        var body = await Post(
            app.ClientFor(DepotsApp.Acme("depots.read", "depots.write")),
            new { id = "dep-4", reason = "lease-ended" });

        Assert.Equal("ok", body.GetProperty("outcome").GetString());
        Assert.Equal("depots-table", body.GetProperty("patch")[0].GetProperty("targetId").GetString());
        Assert.Equal("Table", body.GetProperty("patch")[0].GetProperty("ui").GetProperty("type").GetString());
    }
}
