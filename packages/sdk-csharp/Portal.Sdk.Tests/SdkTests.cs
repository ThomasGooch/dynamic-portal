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
        // `DateRange.from` is a C# keyword. The verbatim identifier lets the
        // parameter keep the name, and the payload must still say "from".
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
