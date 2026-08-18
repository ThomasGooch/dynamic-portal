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
    private static readonly Dictionary<string, Tone> StatusTone = new()
    {
        ["open"] = Tone.Success,
        ["at-capacity"] = Tone.Warning,
        ["closed"] = Tone.Muted,
    };

    public static IReadOnlyDictionary<string, object?> Manifest() =>
        Envelopes.Manifest(
            satelliteId: "depots",
            displayName: "Depot Operations",
            description: "Capacity, utilisation and status by depot.",
            audience: [Audience.Internal],
            screens:
            [
                Envelopes.ScreenDescriptor(
                    "depots.dashboard", "Depots", [Audience.Internal],
                    description: "Capacity overview for the current tenant."),
                Envelopes.ScreenDescriptor(
                    "depots.detail", "Depot detail", [Audience.Internal],
                    parameters: [Envelopes.Param("id", required: true, description: "Depot id")]),
            ],
            actions:
            [
                Envelopes.ActionDescriptor(
                    "depots.close",
                    [Audience.Internal],
                    title: "Close depot",
                    description: "Take a depot out of service. Existing stock must be moved first.",
                    parameters:
                    [
                        Envelopes.ActionParam("id", ParamType.String, required: true, description: "Depot id"),
                        Envelopes.ActionParam(
                            "reason", ParamType.String, required: true,
                            description: "Why the depot is closing",
                            choices: ["maintenance", "lease-ended", "consolidation"]),
                    ]),
            ],
            nav: [Envelopes.NavEntry("depots.dashboard", "Depots", section: "Operations", order: 30)],
            healthPath: "/healthz");

    /// <summary>Rows are shaped for display — tenantId never crosses the wire.</summary>
    private static Dictionary<string, object?> Row(Depot depot) => new()
    {
        ["id"] = depot.Id,
        ["name"] = depot.Name,
        ["region"] = depot.Region,
        ["status"] = depot.Status,
        ["statusTone"] = StatusTone[depot.Status].ToWire(),
        ["utilisation"] = $"{depot.UtilisationPercent}%",
        ["capacity"] = depot.CapacityPallets.ToString("N0"),
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

    public static IReadOnlyDictionary<string, object?> Dashboard(
        IReadOnlyList<Depot> depots,
        IReadOnlyDictionary<string, int> summary)
    {
        var atCapacity = summary.GetValueOrDefault("at-capacity");

        return Envelopes.Screen(
            "depots.dashboard",
            "Depots",
            Ui.Page(title: "Depots").With(
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
                Ui.Section(title: "All depots").With(DepotsTable(depots))),
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
                            ["as"] = "badge", ["tone"] = StatusTone[depot.Status].ToWire(),
                        },
                        new Dictionary<string, object?>
                        {
                            ["label"] = "Utilisation",
                            ["value"] = $"{depot.UsedPallets:N0} of {depot.CapacityPallets:N0} pallets "
                                + $"({depot.UtilisationPercent}%)",
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
