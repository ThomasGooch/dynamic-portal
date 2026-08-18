using Portal.Sdk;

// Emits one of everything the SDK can build, so the TypeScript side can
// validate it against the schemas the hub actually enforces.
//
// A C# test can only check that the SDK produced what the SDK intended. Only
// the protocol package knows whether that is a response the hub accepts — and
// the Python SDK shipped a rejected envelope precisely because nothing crossed
// that boundary.

var screen = Envelopes.Screen(
    "depots.dashboard",
    "Depots",
    Ui.Page(title: "Depots").With(
        Ui.Grid(columns: 3).With(
            Ui.StatTile(label: "Depots", value: "4"),
            Ui.StatTile(label: "At capacity", value: "1", tone: Tone.Warning)),
        Ui.Section(title: "All depots").With(
            Ui.Table(
                columns: [
                    new Dictionary<string, object?> { ["key"] = "name", ["label"] = "Name" },
                ],
                rows: [new Dictionary<string, object?> { ["name"] = "Zürich" }],
                emptyMessage: "No depots.").WithId("depots-table"))),
    breadcrumbs: [Envelopes.Crumb("Depots")],
    ttlSeconds: 30);

var manifest = Envelopes.Manifest(
    satelliteId: "depots",
    displayName: "Depot Operations",
    description: "Capacity and throughput by depot.",
    audience: [Audience.Internal],
    screens: [
        Envelopes.ScreenDescriptor(
            "depots.dashboard", "Depots", [Audience.Internal],
            description: "Capacity overview."),
    ],
    nav: [Envelopes.NavEntry("depots.dashboard", "Depots", section: "Operations", order: 30)],
    healthPath: "/healthz");

var payload = new Dictionary<string, object?>
{
    ["manifest"] = manifest,
    ["screen"] = screen,
    ["actions"] = new Dictionary<string, object?>
    {
        ["ok"] = Envelopes.Ok(message: "Depot updated."),
        ["okBare"] = Envelopes.Ok(),
        ["invalid"] = Envelopes.Invalid(new Dictionary<string, string> { ["name"] = "Already in use" }),
        ["failed"] = Envelopes.Failed("The depot service is unavailable."),
    },
};

Console.WriteLine(PortalJson.Serialize(payload));
