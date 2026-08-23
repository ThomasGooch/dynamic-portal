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
    /// <summary>An audience list on the wire, refusing the empty one.</summary>
    /// <remarks>
    /// The protocol's audience list is <c>.nonempty()</c>, so an empty one is
    /// not "declare nothing and stay closed" — it is a manifest the hub rejects
    /// whole, taking the satellite's screens and actions down with it. Like a
    /// negative TTL it is nearly always computed rather than typed (a filter
    /// over roles that matched none of them), so the empty list that reaches
    /// here is not one anybody wrote, and the rejection should name the
    /// audience rather than the manifest that happens to contain it.
    ///
    /// Shared by all three callers because default-deny is checked in three
    /// places and drifting in one of them is how it stops holding.
    /// </remarks>
    private static List<string> Wire(IReadOnlyList<Audience> audience)
    {
        if (audience.Count == 0)
        {
            throw new ArgumentException(
                "audience must not be empty; the hub rejects the manifest outright rather than "
                    + "reading it as default-deny. Declare [Audience.Internal] explicitly.",
                nameof(audience));
        }

        return audience.Select(value => value.ToWire()).ToList();
    }

    /// <summary>A role list on the wire. Absent stays absent; empty is refused.</summary>
    /// <remarks>
    /// Roles are opt-in, so the parameter is absent by default and no field is
    /// emitted — unlike audience, silence here means un-gated rather than
    /// default-deny. An explicit empty list is still refused, because its only
    /// coherent meaning (nobody) is never what a declaration intends; the empty
    /// set that means nobody arises from narrowing, not from a builder call.
    /// </remarks>
    private static List<string> WireRoles(IReadOnlyList<Role> roles)
    {
        if (roles.Count == 0)
        {
            throw new ArgumentException(
                "roles must not be empty; omit the parameter to leave a resource un-gated.",
                nameof(roles));
        }

        return roles.Select(value => value.ToWire()).ToList();
    }

    /// <summary>A toast, refusing a message that would render blank.</summary>
    /// <remarks>
    /// The protocol's toast message is <c>.min(1)</c>, so an empty one is a
    /// rejected envelope — and were it accepted it would pop an empty box at
    /// the caller, which is worse than saying nothing. Whitespace counts as
    /// empty for the same reason: it is what an interpolated field that turned
    /// out to be blank looks like.
    /// </remarks>
    private static Dictionary<string, object?> Toast(ToastLevel level, string message)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            throw new ArgumentException(
                "a toast needs something to say: the protocol requires a non-empty message and "
                    + "the hub rejects the envelope without one. Omit the toast instead.",
                nameof(message));
        }

        return new Dictionary<string, object?>
        {
            ["level"] = level.ToWire(),
            ["message"] = message,
        };
    }

    /// <summary>A <c>GET /portal/screens/{id}</c> response.</summary>
    public static IReadOnlyDictionary<string, object?> Screen(
        string screenId,
        string title,
        Node ui,
        IReadOnlyList<IReadOnlyDictionary<string, object?>>? breadcrumbs = null,
        int? ttlSeconds = null,
        string? etag = null)
    {
        // `meta.ttlSeconds` is a non-negative int in the protocol, and C#'s
        // `int` cannot say so. Caught here rather than at the hub because a
        // negative TTL is nearly always a computed value — `expiry - now` on a
        // clock that has already passed it — so the number that reaches the
        // wire is not one anybody typed, and the rejection names the envelope
        // rather than the arithmetic that produced it.
        if (ttlSeconds is < 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(ttlSeconds),
                ttlSeconds,
                "ttlSeconds is how long the screen stays fresh, so it cannot be negative; "
                    + "the hub rejects the envelope outright. Pass null for no cache hint.");
        }

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
        // A level with nothing to attach it to is silently discarded below,
        // which reads at the call site as an error toast that was requested and
        // never appeared. Saying so here costs a caller who meant `Failed` one
        // exception; staying quiet costs them the report.
        if (message is null && level != ToastLevel.Success)
        {
            throw new ArgumentException(
                $"a toast level of {level.ToWire()} with no message shows nothing, because the "
                    + "toast is only built when there is something to say. Pass a message.",
                nameof(level));
        }

        var body = new Dictionary<string, object?>
        {
            ["protocol"] = Protocol.Version,
            ["outcome"] = ActionOutcome.Ok.ToWire(),
        };
        if (message is not null) body["toast"] = Toast(level, message);
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
        if (message is not null) body["toast"] = Toast(ToastLevel.Warning, message);
        return body;
    }

    /// <summary>The action did not work, and it was not the caller's doing.</summary>
    public static IReadOnlyDictionary<string, object?> Failed(string message) =>
        new Dictionary<string, object?>
        {
            ["protocol"] = Protocol.Version,
            ["outcome"] = ActionOutcome.Error.ToWire(),
            ["toast"] = Toast(ToastLevel.Error, message),
        };

    /// <summary>Replaces one named node. Pair with <see cref="Node.WithId"/>.</summary>
    public static IReadOnlyDictionary<string, object?> Patch(string targetId, Node ui) =>
        new Dictionary<string, object?> { ["targetId"] = targetId, ["ui"] = ui };

    /// <summary>Sends the caller to another screen after an action.</summary>
    /// <remarks>
    /// <paramref name="satelliteId"/> is what makes this able to leave the
    /// satellite that handled the action. Omitted, the hub resolves the screen
    /// against the current one, which is right for the common case and cannot
    /// express "now go to the order this shipment belongs to".
    /// </remarks>
    public static IReadOnlyDictionary<string, object?> Navigate(
        string screenId,
        IReadOnlyDictionary<string, string>? parameters = null,
        string? satelliteId = null)
    {
        var body = new Dictionary<string, object?> { ["screenId"] = screenId };
        if (satelliteId is not null) body["satelliteId"] = satelliteId;
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
        string? healthPath = null,
        string? summaryScreenId = null,
        IReadOnlyList<Role>? roles = null)
    {
        var body = new Dictionary<string, object?>
        {
            ["protocol"] = Protocol.Version,
            ["satelliteId"] = satelliteId,
            ["displayName"] = displayName,
            ["audience"] = Wire(audience),
            ["screens"] = screens,
            ["actions"] = actions ?? [],
        };
        if (description is not null) body["description"] = description;
        if (nav is not null) body["nav"] = nav;
        if (mcpUrl is not null) body["mcpUrl"] = mcpUrl;
        if (healthPath is not null) body["healthPath"] = healthPath;
        if (summaryScreenId is not null)
            body["summary"] = new Dictionary<string, object?> { ["screenId"] = summaryScreenId };
        if (roles is not null) body["roles"] = WireRoles(roles);
        return body;
    }

    /// <summary>One entry in a manifest's <c>screens</c>.</summary>
    public static IReadOnlyDictionary<string, object?> ScreenDescriptor(
        string screenId,
        string title,
        IReadOnlyList<Audience> audience,
        string? description = null,
        IReadOnlyList<IReadOnlyDictionary<string, object?>>? parameters = null,
        IReadOnlyList<Role>? roles = null)
    {
        var entry = new Dictionary<string, object?>
        {
            ["id"] = screenId,
            ["title"] = title,
            ["audience"] = Wire(audience),
        };
        if (roles is not null) entry["roles"] = WireRoles(roles);
        if (description is not null) entry["description"] = description;
        if (parameters is not null) entry["params"] = parameters;
        return entry;
    }

    /// <summary>One entry in a manifest's <c>actions</c>.</summary>
    /// <remarks>
    /// An action stays uncallable by the gateway until it declares what it
    /// takes, so <paramref name="parameters"/> is how an agent can reach it at
    /// all. Build the entries with <see cref="ActionParam"/>, not
    /// <see cref="Param"/> — an action parameter must state its type.
    /// </remarks>
    public static IReadOnlyDictionary<string, object?> ActionDescriptor(
        string actionId,
        IReadOnlyList<Audience> audience,
        string? title = null,
        string? description = null,
        IReadOnlyList<IReadOnlyDictionary<string, object?>>? parameters = null,
        IReadOnlyList<Role>? roles = null)
    {
        var entry = new Dictionary<string, object?>
        {
            ["id"] = actionId,
            ["audience"] = Wire(audience),
        };
        if (roles is not null) entry["roles"] = WireRoles(roles);
        if (title is not null) entry["title"] = title;
        if (description is not null) entry["description"] = description;
        if (parameters is not null) entry["params"] = parameters;
        return entry;
    }

    /// <summary>A screen parameter. For an action, use <see cref="ActionParam"/>.</summary>
    /// <remarks>
    /// Screens only. A screen param arrives in a query string and is therefore
    /// always a string, so the schema has no <c>type</c> and this does not send
    /// one — which is exactly why an action cannot use it: the hub requires a
    /// type there and rejects the whole manifest without it.
    /// </remarks>
    public static IReadOnlyDictionary<string, object?> Param(
        string name,
        bool required = false,
        string? description = null)
    {
        var entry = new Dictionary<string, object?> { ["name"] = name, ["required"] = required };
        if (description is not null) entry["description"] = description;
        return entry;
    }

    /// <summary>An action parameter, which must say what type it carries.</summary>
    /// <remarks>
    /// <paramref name="choices"/> lets an agent pick from a list rather than
    /// invent a value. The hub only accepts choices on a string parameter —
    /// attached to a number they describe a parameter no value can satisfy —
    /// so this refuses that combination here rather than at request time.
    /// </remarks>
    public static IReadOnlyDictionary<string, object?> ActionParam(
        string name,
        ParamType type,
        bool required = false,
        string? description = null,
        IReadOnlyList<string>? choices = null)
    {
        if (choices is not null && type != ParamType.String)
        {
            throw new ArgumentException(
                $"enumerated choices are only meaningful on a string parameter, not {type.ToWire()}",
                nameof(choices));
        }
        if (choices is not null && choices.Count == 0)
        {
            throw new ArgumentException(
                "an empty choice list describes a parameter no value can satisfy; omit it instead",
                nameof(choices));
        }

        var entry = new Dictionary<string, object?>
        {
            ["name"] = name,
            ["type"] = type.ToWire(),
            ["required"] = required,
        };
        if (description is not null) entry["description"] = description;
        if (choices is not null) entry["enum"] = choices;
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
