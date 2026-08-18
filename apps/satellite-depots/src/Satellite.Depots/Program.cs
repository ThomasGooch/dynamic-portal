using Portal.Sdk;
using Satellite.Depots;

// The third satellite, in a third language. It exists to prove that "any
// language that can serve JSON" is a real claim rather than a slogan: it shares
// no library with the hub except one generated from the hub's own catalog, and
// it verifies the hub's principal itself rather than trusting it.

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(new DepotRepository(DepotRepository.Seed()));
builder.Logging.ClearProviders().AddSimpleConsole();

var secret = Environment.GetEnvironmentVariable("PORTAL_PRINCIPAL_SECRET");
if (string.IsNullOrEmpty(secret))
{
    // Refuses to start rather than defaulting. A well-known secret is a
    // signature check that passes for anyone, which is worse than none at all
    // because it looks like a control.
    throw new InvalidOperationException(
        "PORTAL_PRINCIPAL_SECRET is required. The satellite verifies the hub's "
            + "principal itself, and there is no unsigned mode to fall back to.");
}

var app = builder.Build();
var repository = app.Services.GetRequiredService<DepotRepository>();

const string ReadScope = "depots.read";
const string WriteScope = "depots.write";
string[] declaredAudience = ["internal"];

app.MapGet("/healthz", () => Results.Json(new { status = "ok", protocol = Protocol.Version }));

// Unauthenticated, like the other two satellites and like the conformance kit
// expects. The manifest is the satellite's *declaration* — screen ids, titles,
// nav placement — and carries no tenant data. The hub reads it at boot, before
// any user has arrived and so before it has a principal to present.
//
// This required a token in the first version, and every unit test passed
// because they all sent one. `pnpm conformance` caught it: the kit fetches the
// manifest with no headers, which is the contract the other satellites already
// honoured.
app.MapGet("/portal/manifest", () => Results.Json(Screens.Manifest(), PortalJson.Options));

app.MapGet("/portal/screens/{screenId}", (HttpContext context, string screenId, string? id) =>
    Authenticated(context, ReadScope, principal =>
    {
        if (screenId == "depots.dashboard")
        {
            var depots = repository.List(principal.TenantId);
            return Results.Json(
                Screens.Dashboard(depots, repository.StatusSummary(principal.TenantId)),
                PortalJson.Options);
        }

        if (screenId == "depots.detail")
        {
            if (string.IsNullOrEmpty(id)) return Results.NotFound(new { detail = "missing id" });

            var depot = repository.Get(principal.TenantId, id);
            // 404 rather than 403 on purpose: a 403 would confirm that a depot
            // with this id exists in some other tenant, which is a disclosure
            // in itself.
            return depot is null
                ? Results.NotFound(new { detail = "no such depot" })
                : Results.Json(Screens.Detail(depot), PortalJson.Options);
        }

        return Results.NotFound(new { detail = "no such screen" });
    }));

app.MapPost("/portal/actions/{actionId}", async (HttpContext context, string actionId) =>
    await AuthenticatedAsync(context, WriteScope, async principal =>
    {
        if (actionId != "depots.close") return Results.NotFound(new { detail = "no such action" });

        var form = await ReadParamsAsync(context);
        var id = form.GetValueOrDefault("id");
        var reason = form.GetValueOrDefault("reason");

        var fieldErrors = new Dictionary<string, string>();
        if (string.IsNullOrWhiteSpace(id)) fieldErrors["id"] = "Which depot?";
        if (string.IsNullOrWhiteSpace(reason)) fieldErrors["reason"] = "A reason is required.";
        if (fieldErrors.Count > 0)
        {
            return Results.Json(Envelopes.Invalid(fieldErrors), PortalJson.Options);
        }

        var depot = repository.Get(principal.TenantId, id!);
        if (depot is null)
        {
            return Results.Json(Envelopes.Failed("No such depot."), PortalJson.Options);
        }
        if (depot.UsedPallets > 0)
        {
            // A validation outcome rather than a failure: the user can act on
            // it, and it names the field that has to change.
            return Results.Json(
                Envelopes.Invalid(
                    new Dictionary<string, string>
                    {
                        ["id"] = $"{depot.Name} still holds {depot.UsedPallets:N0} pallets. Move them first.",
                    }),
                PortalJson.Options);
        }

        var closed = repository.Close(principal.TenantId, id!, reason!);
        if (closed is null)
        {
            return Results.Json(Envelopes.Failed("No such depot."), PortalJson.Options);
        }

        // The satellite says what should now be true; the hub applies it. No
        // satellite JavaScript is involved in re-rendering the table.
        return Results.Json(
            Envelopes.Ok(
                message: $"{closed.Name} is closed.",
                patch: [Envelopes.Patch("depots-table", Screens.DepotsTable(repository.List(principal.TenantId)))]),
            PortalJson.Options);
    }));

app.Run();

// Reads action parameters from either a JSON body or a form post, because the
// hub proxies whichever the screen produced.
static async Task<Dictionary<string, string>> ReadParamsAsync(HttpContext context)
{
    var values = new Dictionary<string, string>();

    if (context.Request.HasFormContentType)
    {
        foreach (var field in await context.Request.ReadFormAsync())
        {
            values[field.Key] = field.Value.ToString();
        }
        return values;
    }

    try
    {
        var body = await context.Request.ReadFromJsonAsync<Dictionary<string, System.Text.Json.JsonElement>>();
        foreach (var (key, value) in body ?? [])
        {
            values[key] = value.ValueKind == System.Text.Json.JsonValueKind.String
                ? value.GetString() ?? ""
                : value.ToString();
        }
    }
    catch (System.Text.Json.JsonException)
    {
        // An unreadable body is an empty one; the field errors below say so.
    }

    return values;
}

IResult Authenticated(HttpContext context, string scope, Func<Principal, IResult> handle)
{
    var outcome = Authorize(context, scope);
    return outcome.Failure ?? handle(outcome.Principal!);
}

async Task<IResult> AuthenticatedAsync(HttpContext context, string scope, Func<Principal, Task<IResult>> handle)
{
    var outcome = Authorize(context, scope);
    return outcome.Failure ?? await handle(outcome.Principal!);
}

// Every check the satellite makes about who is calling, in one place —
// enforced here rather than assumed of the hub.
(Principal? Principal, IResult? Failure) Authorize(HttpContext context, string scope)
{
    var header = context.Request.Headers.Authorization.ToString();
    // RFC 7235: the auth-scheme is case-insensitive, so `bearer <token>` is a
    // legal request and must not read as "no credentials at all".
    var separator = header.IndexOf(' ');
    var providedScheme = separator < 0 ? header : header[..separator];
    var token = separator < 0 ? "" : header[(separator + 1)..];

    if (!string.Equals(providedScheme, "Bearer", StringComparison.OrdinalIgnoreCase) || token.Length == 0)
    {
        return (null, Results.Json(new { detail = "missing bearer token" }, statusCode: 401));
    }

    Principal principal;
    try
    {
        principal = Principals.Verify(token, secret);
    }
    catch (InvalidPrincipalException exception)
    {
        return (null, Results.Json(new { detail = exception.Message }, statusCode: 401));
    }

    if (!declaredAudience.Contains(principal.Audience))
    {
        return (null, Results.Json(new { detail = "audience not permitted" }, statusCode: 403));
    }
    if (!principal.Scopes.Contains(scope))
    {
        return (null, Results.Json(new { detail = $"missing scope {scope}" }, statusCode: 403));
    }

    return (principal, null);
}

/// <summary>Exposed so the test project can host the app in-process.</summary>
public partial class Program;
