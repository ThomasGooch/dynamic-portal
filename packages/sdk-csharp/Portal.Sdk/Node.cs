using System.Text.Json;
using System.Text.Json.Serialization;

namespace Portal.Sdk;

/// <summary>
/// A UI node, shaped exactly as the wire format.
/// </summary>
/// <remarks>
/// Hand-written, unlike <c>Ui.g.cs</c>: this is the runtime the generated
/// surface sits on, and it changes when the protocol changes rather than when
/// the catalog does.
///
/// Every optional member is omitted rather than serialised as null. The
/// catalog marks optional props optional, not nullable, so an explicit null is
/// a response the hub rejects — and the cheapest way never to send one is
/// never to construct it.
/// </remarks>
public sealed record Node
{
    /// <summary>The component name, exactly as the catalog spells it.</summary>
    [JsonPropertyName("type")]
    public required string Type { get; init; }

    /// <summary>Optional node name, so an action's <c>patch</c> can address it.</summary>
    [JsonPropertyName("id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Id { get; init; }

    /// <summary>The component's props. Omitted entirely when none were set.</summary>
    [JsonPropertyName("props")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyDictionary<string, object?>? Props { get; init; }

    /// <summary>Child nodes. Omitted entirely when there are none.</summary>
    [JsonPropertyName("children")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<Node>? Children { get; init; }

    /// <summary>Adds children, so props stay named arguments at the call site.</summary>
    /// <remarks>
    /// C# will not accept <c>params</c> before optional arguments, so a single
    /// builder cannot take both. Splitting them keeps the props readable —
    /// <c>Ui.Grid(columns: 3).With(…)</c> rather than an explicit array shoved
    /// in front of them.
    /// </remarks>
    public Node With(params Node[] children) =>
        children.Length == 0 ? this : this with { Children = [.. Children ?? [], .. children] };

    /// <summary>Names a node so an action's <c>patch</c> can address it later.</summary>
    public Node WithId(string id) => this with { Id = id };

    /// <summary>Ties a value to the tool call that produced it.</summary>
    /// <remarks>
    /// A <em>prop</em>, unlike <c>id</c>. Grounding reads <c>props.source</c>,
    /// and so does every provenance mark the renderer draws. The node also has
    /// a top-level <c>source</c> field that nothing reads — writing there is
    /// how the TypeScript SDK got this wrong, and a citation nothing can see is
    /// worse than none at all.
    ///
    /// Only the data-bearing components declare <c>source</c>, and every
    /// component schema is strict, so citing anything else builds a node the
    /// hub refuses. This throws instead, at the call site.
    /// </remarks>
    public Node WithSource(string toolCallId)
    {
        if (!Protocol.Citable.Contains(Type))
        {
            throw new ArgumentException(
                $"{Type} cannot carry a source. Only {string.Join(", ", Protocol.Citable.Order())} "
                    + "declare one, because only they display data a citation would refer to.",
                nameof(toolCallId));
        }

        var props = new Dictionary<string, object?>(Props ?? new Dictionary<string, object?>())
        {
            ["source"] = new Dictionary<string, object?> { ["toolCallId"] = toolCallId },
        };
        return this with { Props = props };
    }
}

/// <summary>Assembles a node, dropping props that were never set.</summary>
public static class NodeBuilder
{
    /// <summary>Builds a node, omitting every prop left unset.</summary>
    public static Node Build(string component, IReadOnlyDictionary<string, object?> props)
    {
        var supplied = props
            .Where(pair => pair.Value is not null)
            .ToDictionary(pair => pair.Key, pair => pair.Value);

        return new Node
        {
            Type = component,
            Props = supplied.Count == 0 ? null : supplied,
        };
    }
}

/// <summary>The serialiser settings a satellite must use.</summary>
/// <remarks>
/// Provided rather than left to the caller because the defaults are wrong for
/// this wire format in one specific way: <c>System.Text.Json</c> escapes
/// non-ASCII by default, so a depot named "Zürich" would go out as
/// <c>Zürich</c>. Valid JSON, and unreadable in every log and diff.
/// </remarks>
public static class PortalJson
{
    /// <summary>Settings a satellite must serialise with.</summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>Serialises a response using <see cref="Options"/>.</summary>
    public static string Serialize(object value) => JsonSerializer.Serialize(value, Options);
}
