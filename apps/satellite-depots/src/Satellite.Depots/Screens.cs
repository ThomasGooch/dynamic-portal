using System.Globalization;
using Portal.Sdk;

namespace Satellite.Depots;

/// <summary>
/// The satellite's declaration and its screens.
/// </summary>
/// <remarks>
/// Note what is absent: any styling. This satellite says "this is a StatTile
/// with tone warning"; what a warning tone looks like is the hub's business.
///
/// Written in C# against a protocol defined in TypeScript, using builders
/// generated from that TypeScript. The contract is still the wire format
/// rather than a shared library — the SDK is a convenience that produces the
/// same JSON, and a satellite that would rather emit dictionaries still can.
/// </remarks>
public static class Screens
{
    /// <summary>
    /// The audience this satellite declares, read by the manifest and by the
    /// request path. One list, so the check at the door cannot drift from the
    /// declaration the hub was given.
    /// </summary>
    public static readonly IReadOnlyList<Audience> DeclaredAudience = [Audience.Internal];

    // No satellite-level roles on purpose: every org role may reach this
    // satellite and read its screens. Only closing a depot is gated, below.
    // The SDK rejects an empty role list rather than treating it as "nobody",
    // so un-gating is expressed by omitting the argument, not by passing [].

    /// <summary>Closing a depot is a platform-only operation.</summary>
    public static readonly IReadOnlyList<Role> CloseRoles = [Role.Platform];

    private static readonly Dictionary<string, Tone> StatusTone = new()
    {
        ["open"] = Tone.Success,
        ["at-capacity"] = Tone.Warning,
        ["closed"] = Tone.Muted,
    };

    // A status the map does not know is a data problem, not a reason to 500 the
    // whole screen: indexing threw `KeyNotFoundException` for anything outside
    // the three seeded values.
    private static Tone ToneFor(string status) =>
        StatusTone.TryGetValue(status, out var tone) ? tone : Tone.Muted;

    public static IReadOnlyDictionary<string, object?> Manifest() =>
        Envelopes.Manifest(
            satelliteId: "depots",
            displayName: "Depot Operations",
            description: "Capacity, utilisation and status by depot.",
            audience: DeclaredAudience,
            screens:
            [
                Envelopes.ScreenDescriptor(
                    "depots.dashboard", "Depots", DeclaredAudience,
                    description: "Capacity overview for the current tenant."),
                Envelopes.ScreenDescriptor(
                    "depots.detail", "Depot detail", DeclaredAudience,
                    parameters: [Envelopes.Param("id", required: true, description: "Depot id")]),
            ],
            actions:
            [
                Envelopes.ActionDescriptor(
                    "depots.close",
                    DeclaredAudience,
                    title: "Close depot",
                    description: "Take a depot out of service. Existing stock must be moved first.",
                    parameters:
                    [
                        Envelopes.ActionParam("id", ParamType.String, required: true, description: "Depot id"),
                        Envelopes.ActionParam(
                            "reason", ParamType.String, required: true,
                            description: "Why the depot is closing",
                            choices: ["maintenance", "lease-ended", "consolidation"]),
                    ],
                    roles: Screens.CloseRoles),
            ],
            nav: [Envelopes.NavEntry("depots.dashboard", "Depots", section: "Operations", order: 30)],
            healthPath: "/healthz",
            // The screen the portal summarises this satellite by. Its stat
            // tiles are the figures; nothing is declared twice.
            summaryScreenId: "depots.dashboard");

    /// <summary>Rows are shaped for display — tenantId never crosses the wire.</summary>
    private static Dictionary<string, object?> Row(Depot depot) => new()
    {
        ["id"] = depot.Id,
        ["name"] = depot.Name,
        ["region"] = depot.Region,
        ["status"] = depot.Status,
        ["statusTone"] = ToneFor(depot.Status).ToWire(),
        ["utilisation"] = $"{depot.UtilisationPercent}%",
        ["capacity"] = depot.CapacityPallets.ToString("N0", CultureInfo.InvariantCulture),
    };

    public static Node DepotsTable(IReadOnlyList<Depot> depots) =>
        Ui.Table(
            columns:
            [
                new Dictionary<string, object?> { ["key"] = "name", ["label"] = "Depot" },
                new Dictionary<string, object?> { ["key"] = "region", ["label"] = "Region" },
                new Dictionary<string, object?>
                {
                    ["key"] = "status", ["label"] = "Status",
                    ["as"] = "badge", ["toneKey"] = "statusTone",
                },
                new Dictionary<string, object?>
                {
                    ["key"] = "utilisation", ["label"] = "Utilisation", ["align"] = "end",
                },
                new Dictionary<string, object?>
                {
                    ["key"] = "capacity", ["label"] = "Capacity (pallets)", ["align"] = "end",
                },
            ],
            rows: [.. depots.Select(Row)],
            rowAction: new Dictionary<string, object?>
            {
                ["screenId"] = "depots.detail", ["paramKey"] = "id",
            },
            emptyMessage: "No depots assigned.")
            .WithId("depots-table");

    /// <summary>
    /// The role-specific half of the dashboard.
    /// </summary>
    /// <remarks>
    /// Additive, never subtractive: everything the shared screen shows is shown
    /// to every role, so a principal holding none of these sees exactly the
    /// dashboard it saw before. The satellite decides this rather than the hub,
    /// because a hub filter would mean the figures had already crossed the wire
    /// to be discarded — and a number nobody was entitled to is not made safe
    /// by not drawing it.
    /// </remarks>
    private static List<Node> RoleSections(
        IReadOnlyList<Depot> depots,
        IReadOnlyCollection<string> roles)
    {
        var sections = new List<Node>();

        if (roles.Contains("finance"))
        {
            // Spare pallets by region: capacity paid for and not used, which is
            // the question finance asks of a depot estate.
            var spareByRegion = depots
                .GroupBy(depot => depot.Region)
                .OrderBy(group => group.Key, StringComparer.Ordinal)
                .Select(group => new Dictionary<string, object?>
                {
                    ["region"] = group.Key,
                    ["spare"] = group.Sum(depot => depot.CapacityPallets - depot.UsedPallets),
                })
                .ToList();

            sections.Add(Ui.Section(
                    title: "Spare capacity by region",
                    description: "Pallets paid for and standing empty.")
                .With(Ui.Chart(
                        kind: ChartKind.Bar,
                        xKey: "region",
                        series:
                        [
                            new Dictionary<string, object?> { ["key"] = "spare", ["label"] = "Spare pallets" },
                        ],
                        data: spareByRegion)
                    .WithId("depots-finance-chart")));
        }

        if (roles.Contains("platform"))
        {
            var regions = depots.Select(depot => depot.Region).Distinct().Count();
            var capacity = depots.Sum(depot => depot.CapacityPallets);
            // Mean of the per-depot percentages, not total used over total
            // capacity: a large depot would otherwise drown three small ones,
            // and "how utilised is a typical site" is the question here.
            var meanUtilisation = depots.Count == 0
                ? 0
                : (int)Math.Round(depots.Average(depot => depot.UtilisationPercent));

            sections.Add(Ui.Section(
                    title: "Estate metrics",
                    description: "Spread and headroom across the estate.")
                // A key/value list rather than stat tiles: the hub headlines
                // the first four StatTiles on a summary screen, so
                // role-conditional tiles would make the front page's figures
                // differ by role. extractData files these as facts, not stats.
                // Invariant culture like every other formatted figure here.
                .With(Ui.KeyValueList(
                    [
                        new Dictionary<string, object?>
                        {
                            ["label"] = "Regions",
                            ["value"] = regions.ToString(CultureInfo.InvariantCulture),
                        },
                        new Dictionary<string, object?>
                        {
                            ["label"] = "Total capacity (pallets)",
                            ["value"] = capacity.ToString("N0", CultureInfo.InvariantCulture),
                        },
                        new Dictionary<string, object?>
                        {
                            ["label"] = "Mean utilisation",
                            ["value"] = $"{meanUtilisation}%",
                            ["tone"] = (meanUtilisation >= 90 ? Tone.Warning : Tone.Success).ToWire(),
                        },
                    ])
                    .WithId("depots-platform-metrics")));
        }

        if (roles.Contains("engineering"))
        {
            // Fullest first: the row that needs a decision is the row at the top.
            var pressure = depots
                .OrderByDescending(depot => depot.UtilisationPercent)
                .Take(5)
                .Select(depot => new Dictionary<string, object?>
                {
                    ["id"] = depot.Id,
                    ["name"] = depot.Name,
                    ["region"] = depot.Region,
                    ["utilisation"] = $"{depot.UtilisationPercent}%",
                })
                .ToList();

            sections.Add(Ui.Section(
                    title: "Capacity pressure",
                    description: "Fullest depots first — where the next pallet has nowhere to go.")
                .With(Ui.Table(
                        columns:
                        [
                            new Dictionary<string, object?> { ["key"] = "name", ["label"] = "Depot" },
                            new Dictionary<string, object?> { ["key"] = "region", ["label"] = "Region" },
                            new Dictionary<string, object?>
                            {
                                ["key"] = "utilisation", ["label"] = "Utilisation", ["align"] = "end",
                            },
                        ],
                        rows: pressure,
                        rowAction: new Dictionary<string, object?>
                        {
                            ["screenId"] = "depots.detail", ["paramKey"] = "id",
                        },
                        emptyMessage: "No depots.")
                    .WithId("depots-capacity-pressure")));
        }

        return sections;
    }

    public static IReadOnlyDictionary<string, object?> Dashboard(
        IReadOnlyList<Depot> depots,
        IReadOnlyDictionary<string, int> summary,
        IReadOnlyCollection<string>? roles = null)
    {
        var atCapacity = summary.GetValueOrDefault("at-capacity");

        return Envelopes.Screen(
            "depots.dashboard",
            "Depots",
            Ui.Page(title: "Depots").With([
                Ui.Grid(columns: 3).With(
                    Ui.StatTile(label: "Depots", value: depots.Count.ToString()),
                    Ui.StatTile(
                        label: "At capacity",
                        value: atCapacity.ToString(),
                        tone: atCapacity > 0 ? Tone.Warning : Tone.Muted),
                    Ui.StatTile(
                        label: "Open",
                        value: summary.GetValueOrDefault("open").ToString(),
                        tone: Tone.Success)),
                Ui.Section(title: "Utilisation").With(
                    Ui.Chart(
                        kind: ChartKind.Bar,
                        xKey: "name",
                        series:
                        [
                            new Dictionary<string, object?>
                            {
                                ["key"] = "used", ["label"] = "Pallets in use",
                            },
                        ],
                        data: [.. depots.Select(depot => new Dictionary<string, object?>
                        {
                            ["name"] = depot.Name,
                            ["used"] = depot.UsedPallets,
                        })])
                        .WithId("depots-utilisation")),
                Ui.Section(title: "All depots").With(DepotsTable(depots)),
                .. RoleSections(depots, roles ?? []),
            ]),
            ttlSeconds: 30);
    }

    public static IReadOnlyDictionary<string, object?> Detail(Depot depot) =>
        Envelopes.Screen(
            "depots.detail",
            $"Depot {depot.Name}",
            Ui.Page().With(
                Ui.Card().With(
                    Ui.KeyValueList(items:
                    [
                        new Dictionary<string, object?> { ["label"] = "Name", ["value"] = depot.Name },
                        new Dictionary<string, object?> { ["label"] = "Region", ["value"] = depot.Region },
                        new Dictionary<string, object?>
                        {
                            ["label"] = "Status", ["value"] = depot.Status,
                            ["as"] = "badge", ["tone"] = ToneFor(depot.Status).ToWire(),
                        },
                        new Dictionary<string, object?>
                        {
                            ["label"] = "Utilisation",
                            ["value"] = string.Format(
                                CultureInfo.InvariantCulture,
                                "{0:N0} of {1:N0} pallets ({2}%)",
                                depot.UsedPallets, depot.CapacityPallets, depot.UtilisationPercent),
                        },
                    ])),
                Ui.Section(title: "Actions").With(
                    Ui.Form(actionId: "depots.close", submitLabel: "Close depot").With(
                        Ui.Hidden(name: "id", value: depot.Id),
                        Ui.Select(
                            name: "reason",
                            label: "Reason",
                            options:
                            [
                                new Dictionary<string, object?> { ["label"] = "Maintenance", ["value"] = "maintenance" },
                                new Dictionary<string, object?> { ["label"] = "Lease ended", ["value"] = "lease-ended" },
                                new Dictionary<string, object?> { ["label"] = "Consolidation", ["value"] = "consolidation" },
                            ])))),
            breadcrumbs:
            [
                Envelopes.Crumb("Depots", "depots.dashboard"),
                Envelopes.Crumb(depot.Name),
            ]);
}
