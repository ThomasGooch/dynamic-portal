"""The satellite's declaration and its screens.

Note what is absent: any styling. This satellite says "this is a Chart of type
bar" and "this StatTile has tone warning"; what a warning tone looks like is the
hub's business. Written in Python against a protocol defined in TypeScript,
which is the point — the contract is the wire format, not a shared library.
"""

from __future__ import annotations

from typing import Any

from .repository import Vehicle

PROTOCOL = "1.0"

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
    return {
        "protocol": PROTOCOL,
        "satelliteId": "fleet",
        "displayName": "Fleet Operations",
        "description": "Vehicle status, utilisation and maintenance.",
        "audience": ["internal"],
        "screens": [
            {
                "id": "fleet.dashboard",
                "title": "Fleet",
                "description": "Status overview for the current tenant.",
                "audience": ["internal"],
            },
            {
                "id": "fleet.detail",
                "title": "Vehicle detail",
                "params": [
                    {"name": "id", "required": True, "description": "Vehicle id"}
                ],
                "audience": ["internal"],
            },
        ],
        "actions": [],
        "nav": [
            {
                "screenId": "fleet.dashboard",
                "label": "Fleet",
                "section": "Operations",
                "order": 20,
            }
        ],
        "healthPath": "/healthz",
    }


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
    return {
        "type": "Table",
        "id": "fleet-table",
        "props": {
            "columns": [
                {"key": "registration", "label": "Registration"},
                {"key": "model", "label": "Model"},
                {"key": "status", "label": "Status", "as": "badge", "toneKey": "statusTone"},
                {"key": "odometerKm", "label": "Odometer (km)", "align": "end"},
                {"key": "depot", "label": "Depot"},
            ],
            "rows": [_row(v) for v in vehicles],
            "rowAction": {"screenId": "fleet.detail", "paramKey": "id"},
            "emptyMessage": "No vehicles assigned.",
        },
    }


def dashboard_screen(vehicles: list[Vehicle], summary: dict[str, int]) -> dict[str, Any]:
    in_maintenance = summary.get("maintenance", 0)
    return {
        "protocol": PROTOCOL,
        "screen": {"id": "fleet.dashboard", "title": "Fleet"},
        "ui": {
            "type": "Page",
            "children": [
                {
                    "type": "Grid",
                    "props": {"columns": 3},
                    "children": [
                        {
                            "type": "StatTile",
                            "props": {"label": "Vehicles", "value": str(len(vehicles))},
                        },
                        {
                            "type": "StatTile",
                            "props": {
                                "label": "In maintenance",
                                "value": str(in_maintenance),
                                "tone": "warning" if in_maintenance else "muted",
                            },
                        },
                        {
                            "type": "StatTile",
                            "props": {
                                "label": "Active",
                                "value": str(summary.get("active", 0)),
                                "tone": "success",
                            },
                        },
                    ],
                },
                {
                    "type": "Section",
                    "props": {"title": "Status breakdown"},
                    "children": [
                        {
                            "type": "Chart",
                            "id": "fleet-status-chart",
                            "props": {
                                "kind": "bar",
                                "xKey": "status",
                                "series": [{"key": "count", "label": "Vehicles"}],
                                "data": [
                                    {"status": status, "count": count}
                                    for status, count in sorted(summary.items())
                                ],
                            },
                        }
                    ],
                },
                {
                    "type": "Section",
                    "props": {"title": "All vehicles"},
                    "children": [vehicles_table(vehicles)],
                },
            ],
        },
        "meta": {"ttlSeconds": 30},
    }


def detail_screen(vehicle: Vehicle) -> dict[str, Any]:
    return {
        "protocol": PROTOCOL,
        "screen": {
            "id": "fleet.detail",
            "title": f"Vehicle {vehicle.registration}",
            "breadcrumbs": [
                {"label": "Fleet", "screenId": "fleet.dashboard"},
                {"label": vehicle.registration},
            ],
        },
        "ui": {
            "type": "Page",
            "children": [
                {
                    "type": "Card",
                    "children": [
                        {
                            "type": "KeyValueList",
                            "props": {
                                "items": [
                                    {"label": "Registration", "value": vehicle.registration},
                                    {"label": "Model", "value": vehicle.model},
                                    {
                                        "label": "Status",
                                        "value": vehicle.status,
                                        "as": "badge",
                                        "tone": _STATUS_TONE[vehicle.status],
                                    },
                                    {
                                        "label": "Odometer",
                                        "value": f"{vehicle.odometer_km:,} km",
                                    },
                                    {"label": "Depot", "value": vehicle.depot},
                                ]
                            },
                        }
                    ],
                }
            ],
        },
    }
