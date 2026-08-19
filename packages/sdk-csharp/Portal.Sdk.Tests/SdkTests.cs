using System.Text.Json;
using Portal.Sdk;
using Xunit;

namespace Portal.Sdk.Tests;

/// <summary>
/// What the SDK must not get wrong.
/// </summary>
/// <remarks>
/// These cover the hand-written runtime and the shape of what the generator
/// emits — not the vocabulary itself, which is the catalog's to define and the
/// drift check's to police.
/// </remarks>
public class BuildingNodes
{
    private static JsonElement Json(object value) =>
        JsonDocument.Parse(PortalJson.Serialize(value)).RootElement;

    [Fact]
    public void OmitsPropsThatWereNeverSet()
    {
        // Absent, not null. The catalog marks optional props optional rather
        // than nullable, so an explicit null is a response the hub rejects.
        var json = Json(Ui.StatTile(label: "Pending", value: "2"));
        var props = json.GetProperty("props");

        Assert.Equal("StatTile", json.GetProperty("type").GetString());
        Assert.Equal("Pending", props.GetProperty("label").GetString());
        Assert.False(props.TryGetProperty("caption", out _));
        Assert.False(props.TryGetProperty("tone", out _));
    }

    [Fact]
    public void OmitsChildrenAndIdWhenAbsent()
    {
        var json = Json(Ui.Badge(label: "A"));
        Assert.False(json.TryGetProperty("children", out _));
        Assert.False(json.TryGetProperty("id", out _));
    }

    [Fact]
    public void CarriesChildrenThroughWith()
    {
        var json = Json(Ui.Grid(columns: 2).With(Ui.Badge(label: "A"), Ui.Badge(label: "B")));

        Assert.Equal(2, json.GetProperty("props").GetProperty("columns").GetInt32());
        Assert.Equal(2, json.GetProperty("children").GetArrayLength());
    }

    [Fact]
    public void WithAppendsRatherThanReplacing()
    {
        // `.With(a).With(b)` reads as adding both. Replacing would silently
        // drop the first, and a screen missing a section is hard to trace back
        // to the builder that dropped it.
        var node = Ui.Stack().With(Ui.Badge(label: "A")).With(Ui.Badge(label: "B"));
        Assert.Equal(2, Json(node).GetProperty("children").GetArrayLength());
    }

    [Fact]
    public void EnumsSerialiseToTheCatalogsStrings()
    {
        // The enum exists so a wrong tone does not compile. It only helps if
        // the value that reaches the wire is the string the catalog declared.
        var json = Json(Ui.StatTile(label: "Active", value: "9", tone: Tone.Success));
        Assert.Equal("success", json.GetProperty("props").GetProperty("tone").GetString());
    }

    [Fact]
    public void KeywordPropsKeepTheirWireName()
    {
        // `from` is only a contextual keyword, so it needs no `@` at all — but
        // `Checkbox.checked` and `Link.params` are reserved and do. Either way
        // the generator's job is that the wire name survives, so this asserts
        // the payload still says "from" rather than a renamed parameter.
        var json = Json(Ui.DateRange(name: "window", label: "Window", from: "2026-01-01"));
        Assert.Equal("2026-01-01", json.GetProperty("props").GetProperty("from").GetString());
    }

    [Fact]
    public void DoesNotEscapeNonAsciiIntoUnreadableness()
    {
        // System.Text.Json escapes non-ASCII by default, so a depot in Zürich
        // would go out as ü — valid JSON, unreadable in every log and diff.
        var serialised = PortalJson.Serialize(Ui.Badge(label: "Zürich"));
        Assert.Contains("Zürich", serialised);
    }

    [Fact]
    public void AVisibilityRuleReachesAFieldAsTheCatalogSpellsIt()
    {
        // The generated builder takes an untyped dictionary, so the helper is
        // the only thing standing between a satellite and a misspelled key it
        // would first hear about from the hub.
        var json = Json(Ui.TextField(
            name: "expediteReason",
            label: "Why?",
            visibleWhen: Visibility.WhenEquals("expedited", true)));
        var rule = json.GetProperty("props").GetProperty("visibleWhen");

        Assert.Equal("expedited", rule.GetProperty("field").GetString());
        Assert.True(rule.GetProperty("equals").GetBoolean());

        var membership = Json(Visibility.WhenOneOf("tags", "hazmat"));
        Assert.Equal("hazmat", membership.GetProperty("oneOf")[0].GetString());
    }

    [Fact]
    public void RefusesAMembershipRuleThatMatchesNothing()
    {
        // An empty list shows the field never, which reads as a missing feature
        // rather than a choice.
        Assert.Throws<ArgumentException>(() => Visibility.WhenOneOf("tags"));
    }
}

public class Provenance
{
    [Fact]
    public void SourceIsAPropBecauseThatIsWhereGroundingLooks()
    {
        // Grounding reads props.source, and so does every provenance mark the
        // renderer draws. The node's top-level `source` field is read by
        // nothing; writing there produces a citation nobody can see.
        var node = Ui.StatTile(label: "Pending", value: "2").WithSource("call-1");
        var json = JsonDocument.Parse(PortalJson.Serialize(node)).RootElement;

        var source = json.GetProperty("props").GetProperty("source");
        Assert.Equal("call-1", source.GetProperty("toolCallId").GetString());
        Assert.False(json.TryGetProperty("source", out _));
    }

    [Fact]
    public void KeepsThePropsItAlreadyHad()
    {
        var node = Ui.StatTile(label: "Pending", value: "2", tone: Tone.Warning)
            .WithSource("call-1");
        var props = JsonDocument.Parse(PortalJson.Serialize(node)).RootElement.GetProperty("props");

        Assert.Equal("warning", props.GetProperty("tone").GetString());
        Assert.Equal("Pending", props.GetProperty("label").GetString());
    }

    [Fact]
    public void RefusesAComponentThatCannotCarryOne()
    {
        // Only four components declare `source` and every schema is strict, so
        // citing a Text builds a node the hub refuses. Throwing here names the
        // mistake at the call site instead of at request time.
        var error = Assert.Throws<ArgumentException>(
            () => Ui.Text(text: "hello").WithSource("call-1"));
        Assert.Contains("cannot carry a source", error.Message);
    }

    [Fact]
    public void IdIsNotAPropBecauseItBelongsToTheNode()
    {
        var node = Ui.Table(columns: [new Dictionary<string, object?> { ["key"] = "id", ["label"] = "Id" }])
            .WithId("fleet-table");
        var json = JsonDocument.Parse(PortalJson.Serialize(node)).RootElement;

        Assert.Equal("fleet-table", json.GetProperty("id").GetString());
        Assert.False(json.GetProperty("props").TryGetProperty("id", out _));
    }
}

public class EnvelopeShapes
{
    private static JsonElement Json(object value) =>
        JsonDocument.Parse(PortalJson.Serialize(value)).RootElement;

    [Fact]
    public void AFailureSaysErrorNotDanger()
    {
        // The bug this SDK inherited a fix for: `danger` is a component tone,
        // not a toast level, and the hub rejects the envelope outright. The
        // vocabulary is generated now precisely so it cannot be retyped wrong.
        var json = Json(Envelopes.Failed("The depot service is unavailable."));
        Assert.Equal("error", json.GetProperty("outcome").GetString());
        Assert.Equal("error", json.GetProperty("toast").GetProperty("level").GetString());
    }

    [Fact]
    public void ValidationAndFailureAreDifferentOutcomes()
    {
        // One is the caller's to fix and renders against the field; the other
        // is the system's. Collapsing them tells someone to correct something
        // they did not get wrong.
        var invalid = Json(Envelopes.Invalid(new Dictionary<string, string> { ["depot"] = "Unknown" }));
        Assert.Equal("validation", invalid.GetProperty("outcome").GetString());
        Assert.Equal("Unknown", invalid.GetProperty("fieldErrors").GetProperty("depot").GetString());
    }

    [Fact]
    public void RefusesAValidationOutcomeWithNothingMarked()
    {
        Assert.Throws<ArgumentException>(
            () => Envelopes.Invalid(new Dictionary<string, string>()));
    }

    [Fact]
    public void AnActionThatOnlySaysDoneSaysOnlyThat()
    {
        var json = Json(Envelopes.Ok());
        Assert.Equal(Protocol.Version, json.GetProperty("protocol").GetString());
        Assert.False(json.TryGetProperty("toast", out _));
    }

    [Fact]
    public void MetaIsAbsentRatherThanEmpty()
    {
        Assert.False(Json(Envelopes.Screen("s", "S", Ui.Page())).TryGetProperty("meta", out _));
        Assert.Equal(
            30,
            Json(Envelopes.Screen("s", "S", Ui.Page(), ttlSeconds: 30))
                .GetProperty("meta").GetProperty("ttlSeconds").GetInt32());
    }

    [Fact]
    public void RefusesATtlThatHasAlreadyExpired()
    {
        // The protocol says non-negative and C#'s `int` cannot. A negative TTL
        // is almost always `expiry - now` against a clock that already passed
        // it, so failing here names the envelope instead of leaving a hub
        // rejection to be traced back to the subtraction.
        var error = Assert.Throws<ArgumentOutOfRangeException>(
            () => Envelopes.Screen("s", "S", Ui.Page(), ttlSeconds: -1));
        Assert.Equal("ttlSeconds", error.ParamName);

        // Zero is a real value — "fresh now, stale immediately" — not an error.
        Assert.Equal(
            0,
            Json(Envelopes.Screen("s", "S", Ui.Page(), ttlSeconds: 0))
                .GetProperty("meta").GetProperty("ttlSeconds").GetInt32());
    }

    [Fact]
    public void ANumericEnumReachesTheWireAsANumber()
    {
        // `Heading.level` is the catalog's `1 | 2 | 3 | 4`. It reached C# as an
        // unconstrained `double` at first, so `level: 2.5` compiled and the hub
        // rejected the screen. It is an enum now, and the wire form has to stay
        // a JSON number — quoting it would be rejected just as fast.
        var props = Json(Ui.Heading(text: "Depots", level: HeadingLevel.Level2))
            .GetProperty("props");

        Assert.Equal(JsonValueKind.Number, props.GetProperty("level").ValueKind);
        Assert.Equal(2, props.GetProperty("level").GetInt32());
    }

    [Fact]
    public void AnActionParameterStatesItsType()
    {
        // An action payload is JSON, where 2 and "2" are different values, so
        // the hub requires a type and rejects the whole manifest without one.
        var json = Json(Envelopes.ActionParam("capacity", ParamType.Number));

        Assert.Equal("number", json.GetProperty("type").GetString());
        Assert.False(json.GetProperty("required").GetBoolean());
    }

    [Fact]
    public void AScreenParameterDoesNotStateOne()
    {
        // Deliberate, not an omission: a screen param arrives in a query string
        // and is always a string, and the schema is strict, so sending a type
        // here would be rejected.
        Assert.False(Json(Envelopes.Param("page")).TryGetProperty("type", out _));
    }

    [Fact]
    public void RefusesChoicesOnAParameterNoStringCanSatisfy()
    {
        // Choices are strings. On a number they describe a parameter no value
        // satisfies, which reads as a callable action and is not one.
        Assert.Throws<ArgumentException>(
            () => Envelopes.ActionParam("qty", ParamType.Number, choices: ["1", "2"]));
    }

    [Fact]
    public void AnActionDescriptorCarriesItsAudienceAndParams()
    {
        var json = Json(Envelopes.ActionDescriptor(
            "depots.rename",
            [Audience.Internal],
            parameters: [Envelopes.ActionParam("depotId", ParamType.String, required: true)]));

        Assert.Equal("depots.rename", json.GetProperty("id").GetString());
        Assert.Equal("internal", json.GetProperty("audience")[0].GetString());
        Assert.Equal("string", json.GetProperty("params")[0].GetProperty("type").GetString());
        Assert.False(json.TryGetProperty("title", out _));
    }

    [Fact]
    public void NavigationCanLeaveTheSatelliteThatHandledTheAction()
    {
        // Without `satelliteId` the hub resolves against the current satellite,
        // so "now go to the order this shipment belongs to" is unreachable.
        Assert.False(Json(Envelopes.Navigate("depots.dashboard")).TryGetProperty("satelliteId", out _));
        Assert.Equal(
            "orders",
            Json(Envelopes.Navigate("orders.detail", satelliteId: "orders"))
                .GetProperty("satelliteId").GetString());
    }

    [Fact]
    public void RefusesAnAudienceThatDeclaresNobody()
    {
        // The protocol's audience list is `.nonempty()`, so an empty one is not
        // default-deny — it is a manifest the hub rejects whole. Checked on all
        // three, because the check only holds where it is applied.
        Assert.Throws<ArgumentException>(
            () => Envelopes.Manifest("depots", "Depots", [], screens: []));
        Assert.Throws<ArgumentException>(
            () => Envelopes.ScreenDescriptor("depots.dashboard", "Depots", []));
        Assert.Throws<ArgumentException>(
            () => Envelopes.ActionDescriptor("depots.rename", []));
    }

    [Fact]
    public void RefusesAToastWithNothingToSay()
    {
        // `message` is `.min(1)` in the protocol, and a blank toast would pop an
        // empty box at the caller even if the hub let it through.
        Assert.Throws<ArgumentException>(() => Envelopes.Failed("   "));
        Assert.Throws<ArgumentException>(() => Envelopes.Ok(message: ""));
        Assert.Throws<ArgumentException>(
            () => Envelopes.Invalid(new Dictionary<string, string> { ["name"] = "Taken" }, message: ""));
    }

    [Fact]
    public void RefusesAToastLevelThatWouldBeSilentlyDropped()
    {
        // The toast is only built when there is a message, so a level on its own
        // vanishes — which reads at the call site as a report that was asked for
        // and never arrived.
        Assert.Throws<ArgumentException>(() => Envelopes.Ok(level: ToastLevel.Error));

        // The default level with no message is the ordinary "it worked" case and
        // stays legal.
        Assert.False(Json(Envelopes.Ok()).TryGetProperty("toast", out _));
    }

    [Fact]
    public void AudiencesReachTheWireAsStrings()
    {
        var json = Json(Envelopes.Manifest(
            satelliteId: "depots",
            displayName: "Depots",
            audience: [Audience.Internal],
            screens: []));

        Assert.Equal("internal", json.GetProperty("audience")[0].GetString());
        Assert.Equal(0, json.GetProperty("actions").GetArrayLength());
    }
}
