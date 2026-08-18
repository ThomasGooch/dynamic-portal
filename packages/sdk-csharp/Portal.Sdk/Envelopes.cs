namespace Portal.Sdk;

/// <summary>
/// The responses a satellite gives, and nothing else.
/// </summary>
/// <remarks>
/// PUP is three endpoints. The builders make a valid tree; these make a valid
/// envelope around it, so a satellite using both never assembles a response by
/// hand — which is where the protocol version, the key names and the outcome
/// vocabulary go wrong.
///
/// The shapes here are hand-written because they track the protocol's envelope
/// structure. The vocabulary is not: levels, outcomes, audiences and the
/// version come from <c>Protocol.g.cs</c>, which is generated.
/// </remarks>
public static class Envelopes
{
    /// <summary>A <c>GET /portal/screens/{id}</c> response.</summary>
    public static IReadOnlyDictionary<string, object?> Screen(
        string screenId,
        string title,
        Node ui,
        IReadOnlyList<IReadOnlyDictionary<string, object?>>? breadcrumbs = null,
        int? ttlSeconds = null,
        string? etag = null)
    {
        var descriptor = new Dictionary<string, object?> { ["id"] = screenId, ["title"] = title };
        if (breadcrumbs is not null) descriptor["breadcrumbs"] = breadcrumbs;

        var body = new Dictionary<string, object?>
        {
            ["protocol"] = Protocol.Version,
            ["screen"] = descriptor,
            ["ui"] = ui,
        };

        var meta = new Dictionary<string, object?>();
        if (ttlSeconds is not null) meta["ttlSeconds"] = ttlSeconds;
        if (etag is not null) meta["etag"] = etag;
        if (meta.Count > 0) body["meta"] = meta;

        return body;
    }

    /// <summary>One breadcrumb. The last is the current screen and does not link.</summary>
    public static IReadOnlyDictionary<string, object?> Crumb(string label, string? screenId = null)
    {
        var crumb = new Dictionary<string, object?> { ["label"] = label };
        if (screenId is not null) crumb["screenId"] = screenId;
        return crumb;
    }

    /// <summary>An action that worked.</summary>
    public static IReadOnlyDictionary<string, object?> Ok(
        string? message = null,
        ToastLevel level = ToastLevel.Success,
        IReadOnlyList<IReadOnlyDictionary<string, object?>>? patch = null,
        IReadOnlyDictionary<string, object?>? navigate = null)
    {
        var body = new Dictionary<string, object?>
        {
            ["protocol"] = Protocol.Version,
            ["outcome"] = ActionOutcome.Ok.ToWire(),
        };
        if (message is not null)
        {
            body["toast"] = new Dictionary<string, object?>
            {
                ["level"] = level.ToWire(),
                ["message"] = message,
            };
        }
        if (patch is not null) body["patch"] = patch;
        if (navigate is not null) body["navigate"] = navigate;
        return body;
    }

    /// <summary>The input was wrong, and here is which field.</summary>
    /// <remarks>
    /// Distinct from <see cref="Failed"/> deliberately: this renders inline
    /// against the offending fields and is the caller's to fix. A failure is
    /// the system's. Collapsing them tells someone to correct something they
    /// did not get wrong.
    /// </remarks>
    public static IReadOnlyDictionary<string, object?> Invalid(
        IReadOnlyDictionary<string, string> fieldErrors,
        string? message = null)
    {
        if (fieldErrors.Count == 0)
        {
            throw new ArgumentException(
                "A validation outcome needs at least one field error; the hub rejects an empty "
                    + "map, and a user shown 'something is wrong' with nothing marked cannot act.",
                nameof(fieldErrors));
        }

        var body = new Dictionary<string, object?>
        {
            ["protocol"] = Protocol.Version,
            ["outcome"] = ActionOutcome.Validation.ToWire(),
            ["fieldErrors"] = fieldErrors,
        };
        if (message is not null)
        {
            body["toast"] = new Dictionary<string, object?>
            {
                ["level"] = ToastLevel.Warning.ToWire(),
                ["message"] = message,
            };
        }
        return body;
    }

    /// <summary>The action did not work, and it was not the caller's doing.</summary>
    public static IReadOnlyDictionary<string, object?> Failed(string message) =>
        new Dictionary<string, object?>
        {
            ["protocol"] = Protocol.Version,
            ["outcome"] = ActionOutcome.Error.ToWire(),
            ["toast"] = new Dictionary<string, object?>
            {
                ["level"] = ToastLevel.Error.ToWire(),
                ["message"] = message,
            },
        };

    /// <summary>Replaces one named node. Pair with <see cref="Node.WithId"/>.</summary>
    public static IReadOnlyDictionary<string, object?> Patch(string targetId, Node ui) =>
        new Dictionary<string, object?> { ["targetId"] = targetId, ["ui"] = ui };

    /// <summary>Sends the caller to another screen after an action.</summary>
    public static IReadOnlyDictionary<string, object?> Navigate(
        string screenId,
        IReadOnlyDictionary<string, string>? parameters = null)
    {
        var body = new Dictionary<string, object?> { ["screenId"] = screenId };
        if (parameters is not null) body["params"] = parameters;
        return body;
    }

    /// <summary>A <c>GET /portal/manifest</c> response.</summary>
    /// <remarks>
    /// <paramref name="audience"/> has no default and must be stated. Every
    /// screen and action must declare an audience that is a subset of it — the
    /// hub rejects a manifest where a screen is wider than its satellite, so a
    /// satellite cannot widen its own reach by forgetting.
    /// </remarks>
    public static IReadOnlyDictionary<string, object?> Manifest(
        string satelliteId,
        string displayName,
        IReadOnlyList<Audience> audience,
        IReadOnlyList<IReadOnlyDictionary<string, object?>> screens,
        IReadOnlyList<IReadOnlyDictionary<string, object?>>? actions = null,
        string? description = null,
        IReadOnlyList<IReadOnlyDictionary<string, object?>>? nav = null,
        string? mcpUrl = null,
        string? healthPath = null)
    {
        var body = new Dictionary<string, object?>
        {
            ["protocol"] = Protocol.Version,
            ["satelliteId"] = satelliteId,
            ["displayName"] = displayName,
            ["audience"] = audience.Select(value => value.ToWire()).ToList(),
            ["screens"] = screens,
            ["actions"] = actions ?? [],
        };
        if (description is not null) body["description"] = description;
        if (nav is not null) body["nav"] = nav;
        if (mcpUrl is not null) body["mcpUrl"] = mcpUrl;
        if (healthPath is not null) body["healthPath"] = healthPath;
        return body;
    }

    /// <summary>One entry in a manifest's <c>screens</c>.</summary>
    public static IReadOnlyDictionary<string, object?> ScreenDescriptor(
        string screenId,
        string title,
        IReadOnlyList<Audience> audience,
        string? description = null,
        IReadOnlyList<IReadOnlyDictionary<string, object?>>? parameters = null)
    {
        var entry = new Dictionary<string, object?>
        {
            ["id"] = screenId,
            ["title"] = title,
            ["audience"] = audience.Select(value => value.ToWire()).ToList(),
        };
        if (description is not null) entry["description"] = description;
        if (parameters is not null) entry["params"] = parameters;
        return entry;
    }

    /// <summary>A screen or action parameter.</summary>
    public static IReadOnlyDictionary<string, object?> Param(
        string name,
        bool required = false,
        string? description = null)
    {
        var entry = new Dictionary<string, object?> { ["name"] = name, ["required"] = required };
        if (description is not null) entry["description"] = description;
        return entry;
    }

    /// <summary>Where this satellite appears in the hub's navigation.</summary>
    public static IReadOnlyDictionary<string, object?> NavEntry(
        string screenId,
        string label,
        string? section = null,
        int? order = null)
    {
        var entry = new Dictionary<string, object?> { ["screenId"] = screenId, ["label"] = label };
        if (section is not null) entry["section"] = section;
        if (order is not null) entry["order"] = order;
        return entry;
    }
}
