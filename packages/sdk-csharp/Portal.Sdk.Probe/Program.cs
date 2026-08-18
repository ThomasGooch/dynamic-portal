using Portal.Sdk;

// Emits one of everything the SDK can build, so the TypeScript side can
// validate it against the schemas the hub actually enforces.
//
// A C# test can only check that the SDK produced what the SDK intended. Only
// the protocol package knows whether that is a response the hub accepts — and
// the Python SDK shipped a rejected envelope precisely because nothing crossed
// that boundary.
//
// "One of everything" is meant literally and is enforced: `validate.ts` fails
// if a catalog component or a generated enum value never appears below, so a
// component added to the catalog cannot quietly go unchecked here.

var columns = new[]
{
    new Dictionary<string, object?> { ["key"] = "name", ["label"] = "Name" },
    new Dictionary<string, object?>
    {
        ["key"] = "status",
        ["label"] = "Status",
        ["align"] = "end",
        ["as"] = "badge",
        ["toneKey"] = "statusTone",
    },
};

var options = new[]
{
    new Dictionary<string, object?> { ["value"] = "zrh", ["label"] = "Zürich" },
    new Dictionary<string, object?> { ["value"] = "bsl", ["label"] = "Basel", ["disabled"] = true },
};

// Every component in the catalog, every generated enum value, and every prop
// the builders expose — flat, because `validateNested` checks each node against
// its own schema and imposes no parent/child rules.
var everything = new[]
{
    Ui.Section(title: "All of it", description: "One of each.", collapsible: true),
    Ui.Stack(direction: StackDirection.Row, gap: Gap.Md, align: Align.Center, wrap: true),
    Ui.Stack(direction: StackDirection.Column, gap: Gap.None, align: Align.Start),
    Ui.Stack(gap: Gap.Xs, align: Align.End),
    Ui.Stack(gap: Gap.Sm),
    Ui.Stack(gap: Gap.Lg),
    Ui.Grid(columns: 3, gap: Gap.Md).With(
        Ui.StatTile(label: "Depots", value: "4"),
        Ui.StatTile(label: "At capacity", value: "1", caption: "of 4", tone: Tone.Warning)
            .WithSource("call-stat")),
    Ui.Card(title: "Neutral", tone: Tone.Neutral),
    Ui.Card(title: "Muted", tone: Tone.Muted),
    Ui.Card(title: "Info", tone: Tone.Info),
    Ui.Card(title: "Success", tone: Tone.Success),
    Ui.Card(title: "Danger", tone: Tone.Danger),
    Ui.Tabs(
        tabs: [
            new Dictionary<string, object?> { ["id"] = "open", ["label"] = "Open" },
            new Dictionary<string, object?> { ["id"] = "closed", ["label"] = "Closed" },
        ],
        activeId: "open"),
    Ui.Divider(spacing: Gap.Lg),
    Ui.Modal(title: "Confirm", open: false, size: Size.Lg),
    Ui.Heading(text: "H1", level: HeadingLevel.Level1),
    Ui.Heading(text: "H2", level: HeadingLevel.Level2),
    Ui.Heading(text: "H3", level: HeadingLevel.Level3),
    Ui.Heading(text: "H4", level: HeadingLevel.Level4),
    Ui.Text(text: "Small", tone: Tone.Muted, size: Size.Sm, emphasis: true),
    Ui.Text(text: "Medium", size: Size.Md),
    Ui.Badge(label: "New", tone: Tone.Info),
    Ui.KeyValueList(
        items: [
            new Dictionary<string, object?>
            {
                ["label"] = "Opened",
                ["value"] = "2026-01-04",
                ["as"] = "date",
                ["tone"] = "neutral",
            },
        ],
        source: new Dictionary<string, object?> { ["toolCallId"] = "call-kv" }),
    Ui.Table(
        columns: columns,
        rows: [new Dictionary<string, object?> { ["name"] = "Zürich", ["statusTone"] = "success" }],
        dataSource: new Dictionary<string, object?>
        {
            ["screenId"] = "depots.dashboard",
            ["satelliteId"] = "depots",
            ["params"] = new Dictionary<string, string> { ["page"] = "2" },
        },
        rowAction: new Dictionary<string, object?>
        {
            ["screenId"] = "depots.dashboard",
            ["paramKey"] = "depot",
        },
        emptyMessage: "No depots.",
        page: 1,
        pageSize: 25,
        total: 4).WithId("depots-table").WithSource("call-table"),
    Ui.Chart(
        kind: ChartKind.Line,
        xKey: "day",
        series: [new Dictionary<string, object?> { ["key"] = "in", ["label"] = "Inbound" }],
        data: [new Dictionary<string, object?> { ["day"] = "Mon", ["in"] = 12 }])
        .WithSource("call-chart"),
    Ui.Chart(kind: ChartKind.Bar, xKey: "day", series: []),
    Ui.Chart(kind: ChartKind.Area, xKey: "day", series: []),
    Ui.Chart(kind: ChartKind.Donut, xKey: "day", series: []),
    Ui.Alert(level: AlertLevel.Info, message: "Informational.", title: "Note"),
    Ui.Alert(level: AlertLevel.Success, message: "Done."),
    Ui.Alert(level: AlertLevel.Warning, message: "Nearly full."),
    Ui.Alert(level: AlertLevel.Error, message: "Unavailable."),
    Ui.EmptyState(
        title: "Nothing here",
        message: "No depots match.",
        action: new Dictionary<string, object?>
        {
            ["actionId"] = "depots.create",
            ["payload"] = new Dictionary<string, object?> { ["region"] = "ch" },
        },
        actionLabel: "Add a depot"),
    Ui.Timeline(
        items: [
            new Dictionary<string, object?>
            {
                ["timestamp"] = "2026-01-04T09:00:00Z",
                ["label"] = "Opened",
                ["description"] = "By dispatch.",
                ["tone"] = "success",
            },
        ]),
    Ui.Form(
        actionId: "depots.rename",
        submitLabel: "Rename",
        confirm: new Dictionary<string, object?>
        {
            ["title"] = "Rename this depot?",
            ["body"] = "Links elsewhere keep working.",
        }).With(
        Ui.TextField(
            name: "name", label: "Name", required: true, help: "Shown in the list.",
            disabled: false, value: "Zürich", placeholder: "Depot name"),
        Ui.TextArea(name: "notes", label: "Notes", value: "", rows: 4),
        Ui.NumberField(
            name: "capacity", label: "Capacity", value: 120, min: 0, max: 500, step: 10),
        Ui.Select(name: "region", label: "Region", options: options, value: "zrh"),
        Ui.MultiSelect(name: "tags", label: "Tags", options: options, value: ["zrh"]),
        Ui.DateField(name: "opened", label: "Opened", value: "2026-01-04"),
        Ui.DateRange(name: "window", label: "Window", from: "2026-01-01", to: "2026-01-31"),
        Ui.Checkbox(name: "active", label: "Active", @checked: true),
        Ui.Switch(name: "alerts", label: "Alerts", @checked: false),
        Ui.RadioGroup(name: "shift", label: "Shift", options: options, value: "bsl"),
        Ui.FileUpload(name: "plan", label: "Floor plan", accept: [".pdf"], multiple: false),
        Ui.Hidden(name: "depotId", value: "zrh")),
    Ui.Button(
        label: "Primary", variant: ButtonVariant.Primary, size: Size.Sm, disabled: false,
        action: new Dictionary<string, object?> { ["actionId"] = "depots.rename" },
        confirm: new Dictionary<string, object?> { ["title"] = "Sure?" }),
    Ui.Button(label: "Secondary", variant: ButtonVariant.Secondary),
    Ui.Button(label: "Danger", variant: ButtonVariant.Danger),
    Ui.Button(label: "Ghost", variant: ButtonVariant.Ghost),
    Ui.Link(
        label: "Depots",
        screenId: "depots.dashboard",
        satelliteId: "depots",
        @params: new Dictionary<string, string> { ["page"] = "1" }),
    Ui.Link(label: "Status page", href: "https://example.invalid/status"),
    Ui.MenuButton(
        label: "More",
        items: [
            new Dictionary<string, object?>
            {
                ["label"] = "Rename",
                ["action"] = new Dictionary<string, object?> { ["actionId"] = "depots.rename" },
            },
            new Dictionary<string, object?>
            {
                ["label"] = "Open",
                ["screenId"] = "depots.dashboard",
            },
        ]),
};

var screen = Envelopes.Screen(
    "depots.dashboard",
    "Depots",
    Ui.Page(title: "Depots").With(everything),
    breadcrumbs: [Envelopes.Crumb("Fleet", "fleet.home"), Envelopes.Crumb("Depots")],
    ttlSeconds: 30,
    etag: "W/\"depots-1\"");

var manifest = Envelopes.Manifest(
    satelliteId: "depots",
    displayName: "Depot Operations",
    description: "Capacity and throughput by depot.",
    audience: [Audience.Internal, Audience.External],
    screens: [
        Envelopes.ScreenDescriptor(
            "depots.dashboard", "Depots", [Audience.Internal],
            description: "Capacity overview.",
            parameters: [
                Envelopes.Param("page"),
                Envelopes.Param("region", required: true, description: "Two-letter region."),
            ]),
    ],
    actions: [
        Envelopes.ActionDescriptor(
            "depots.rename",
            [Audience.Internal],
            title: "Rename a depot",
            description: "Changes the display name.",
            parameters: [
                Envelopes.ActionParam("depotId", ParamType.String, required: true),
                Envelopes.ActionParam("capacity", ParamType.Number, description: "Pallet slots."),
                Envelopes.ActionParam("active", ParamType.Boolean),
                Envelopes.ActionParam(
                    "region", ParamType.String, choices: ["ch", "de", "fr"]),
            ]),
        Envelopes.ActionDescriptor("depots.archive", [Audience.External]),
    ],
    nav: [Envelopes.NavEntry("depots.dashboard", "Depots", section: "Operations", order: 30)],
    mcpUrl: "https://depots.example.invalid/mcp",
    healthPath: "/healthz");

var payload = new Dictionary<string, object?>
{
    ["manifest"] = manifest,
    ["screen"] = screen,
    ["actions"] = new Dictionary<string, object?>
    {
        ["ok"] = Envelopes.Ok(message: "Depot updated."),
        ["okBare"] = Envelopes.Ok(),
        ["okInfoToast"] = Envelopes.Ok(message: "Queued.", level: ToastLevel.Info),
        ["okWarnToast"] = Envelopes.Ok(message: "Partly applied.", level: ToastLevel.Warning),
        ["okErrorToast"] = Envelopes.Ok(message: "One depot skipped.", level: ToastLevel.Error),
        ["okWithPatch"] = Envelopes.Ok(
            message: "Renamed.",
            patch: [Envelopes.Patch("depots-table", Ui.Badge(label: "Renamed"))],
            navigate: Envelopes.Navigate("depots.dashboard")),
        ["okWithCrossSatelliteNavigate"] = Envelopes.Ok(
            navigate: Envelopes.Navigate(
                "orders.detail",
                new Dictionary<string, string> { ["orderId"] = "A-1" },
                satelliteId: "orders")),
        ["invalid"] = Envelopes.Invalid(new Dictionary<string, string> { ["name"] = "Already in use" }),
        ["invalidWithToast"] = Envelopes.Invalid(
            new Dictionary<string, string> { ["name"] = "Already in use" },
            message: "Check the highlighted fields."),
        ["failed"] = Envelopes.Failed("The depot service is unavailable."),
    },
};

Console.WriteLine(PortalJson.Serialize(payload));
