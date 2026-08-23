"""The satellite's declaration and its screens.

Note what is absent: any styling. This satellite says "this is a Chart of type
bar" and "this StatTile has tone warning"; what a warning tone looks like is
the hub's business.

Written in Python against a protocol defined in TypeScript — and, since the
SDK arrived, against builders *generated* from that TypeScript. The contract is
still the wire format rather than a shared library: `portal_sdk` is a
convenience that produces the same JSON this module used to assemble by hand,
and a satellite that would rather write dicts still can.

What changed with the port: a misspelled component or prop is now a `TypeError`
here, naming the component, instead of a rejected response from the hub at
request time in an environment this process cannot see.
"""

from __future__ import annotations

from typing import Any

from portal_sdk import envelopes as env
from portal_sdk import ui, with_id

from .repository import Vehicle

#: Re-exported so the health endpoint can report it without importing the SDK.
PROTOCOL = env.PROTOCOL

_STATUS_TONE = {
    "active": "success",
    "maintenance": "warning",
    "idle": "info",
    "retired": "muted",
}


def manifest() -> dict[str, Any]:
    # No mcpUrl: this satellite deliberately ships no MCP server, so the hub
    # must generate a shim from this declaration. It is the case that proves
    # "most satellites, not all" is actually handled.
    return env.manifest(
        satellite_id="fleet",
        display_name="Fleet Operations",
        description="Vehicle status, utilisation and maintenance.",
        audience=["internal"],
        # Org roles this satellite is offered to. Screens inherit it (they
        # declare none of their own), so one satellite-level gate covers them.
        roles=["leadership", "engineering", "platform"],
        screens=[
            env.screen_descriptor(
                "fleet.dashboard",
                "Fleet",
                description="Status overview for the current tenant.",
                audience=["internal"],
            ),
            env.screen_descriptor(
                "fleet.detail",
                "Vehicle detail",
                audience=["internal"],
                params=[env.param("id", required=True, description="Vehicle id")],
            ),
        ],
        actions=[],
        nav=[env.nav_entry("fleet.dashboard", "Fleet", section="Operations", order=20)],
        health_path="/healthz",
        # The screen the portal's front page reads this satellite's figures
        # from. Its stat tiles are the summary; there is no second copy.
        summary_screen_id="fleet.dashboard",
    )


def _row(vehicle: Vehicle) -> dict[str, Any]:
    """Rows are shaped for display — tenant_id never crosses the wire."""
    return {
        "id": vehicle.id,
        "registration": vehicle.registration,
        "model": vehicle.model,
        "status": vehicle.status,
        "statusTone": _STATUS_TONE[vehicle.status],
        "odometerKm": f"{vehicle.odometer_km:,}",
        "depot": vehicle.depot,
    }


def vehicles_table(vehicles: list[Vehicle]) -> dict[str, Any]:
    return with_id(
        "fleet-table",
        ui.table(
            columns=[
                {"key": "registration", "label": "Registration"},
                {"key": "model", "label": "Model"},
                {"key": "status", "label": "Status", "as": "badge", "toneKey": "statusTone"},
                {"key": "odometerKm", "label": "Odometer (km)", "align": "end"},
                {"key": "depot", "label": "Depot"},
            ],
            rows=[_row(v) for v in vehicles],
            rowAction={"screenId": "fleet.detail", "paramKey": "id"},
            emptyMessage="No vehicles assigned.",
        ),
    )


def dashboard_screen(vehicles: list[Vehicle], summary: dict[str, int]) -> dict[str, Any]:
    in_maintenance = summary.get("maintenance", 0)

    return env.screen(
        "fleet.dashboard",
        "Fleet",
        ui.page(
            ui.grid(
                ui.stat_tile(label="Vehicles", value=str(len(vehicles))),
                ui.stat_tile(
                    label="In maintenance",
                    value=str(in_maintenance),
                    tone="warning" if in_maintenance else "muted",
                ),
                ui.stat_tile(
                    label="Active",
                    value=str(summary.get("active", 0)),
                    tone="success",
                ),
                columns=3,
            ),
            ui.section(
                with_id(
                    "fleet-status-chart",
                    ui.chart(
                        kind="bar",
                        xKey="status",
                        series=[{"key": "count", "label": "Vehicles"}],
                        data=[
                            {"status": status, "count": count}
                            for status, count in sorted(summary.items())
                        ],
                    ),
                ),
                title="Status breakdown",
            ),
            ui.section(vehicles_table(vehicles), title="All vehicles"),
        ),
        ttl_seconds=30,
    )


def detail_screen(vehicle: Vehicle) -> dict[str, Any]:
    return env.screen(
        "fleet.detail",
        f"Vehicle {vehicle.registration}",
        ui.page(
            ui.card(
                ui.key_value_list(
                    items=[
                        {"label": "Registration", "value": vehicle.registration},
                        {"label": "Model", "value": vehicle.model},
                        {
                            "label": "Status",
                            "value": vehicle.status,
                            "as": "badge",
                            "tone": _STATUS_TONE[vehicle.status],
                        },
                        {"label": "Odometer", "value": f"{vehicle.odometer_km:,} km"},
                        {"label": "Depot", "value": vehicle.depot},
                    ]
                )
            )
        ),
        breadcrumbs=[
            env.crumb("Fleet", "fleet.dashboard"),
            env.crumb(vehicle.registration),
        ],
    )
