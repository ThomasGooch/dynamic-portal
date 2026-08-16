"""In-memory vehicle store, scoped by tenant at every entry point.

Every read takes ``tenant_id`` as its first argument rather than filtering
afterwards, so "forgot to scope" is a signature mismatch at the call site
instead of a silent disclosure. A real satellite would push the predicate into
SQL; the shape of the interface is the part worth copying.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Literal

VehicleStatus = Literal["active", "maintenance", "idle", "retired"]


@dataclass(slots=True)
class Vehicle:
    id: str
    tenant_id: str
    registration: str
    model: str
    status: VehicleStatus
    odometer_km: int
    depot: str


def seed_vehicles() -> list[Vehicle]:
    return [
        Vehicle("veh-77", "acme", "AC-1177", "Volvo FH16", "maintenance", 412_880, "Tucson"),
        Vehicle("veh-78", "acme", "AC-1178", "Volvo FH16", "active", 210_140, "Tucson"),
        Vehicle("veh-79", "acme", "AC-1179", "Scania R450", "active", 88_305, "Phoenix"),
        Vehicle("veh-80", "acme", "AC-1180", "Scania R450", "idle", 155_602, "Phoenix"),
        Vehicle("veh-12", "globex", "GX-0012", "MAN TGX", "maintenance", 502_119, "Newark"),
        Vehicle("veh-13", "globex", "GX-0013", "MAN TGX", "active", 61_470, "Newark"),
    ]


class VehicleRepository:
    def __init__(self, vehicles: list[Vehicle]) -> None:
        # Copy so callers cannot mutate the seed and leak state between tests.
        self._vehicles = [replace(v) for v in vehicles]

    def list(self, tenant_id: str) -> list[Vehicle]:
        return [replace(v) for v in self._vehicles if v.tenant_id == tenant_id]

    def get(self, tenant_id: str, vehicle_id: str) -> Vehicle | None:
        for v in self._vehicles:
            if v.id == vehicle_id and v.tenant_id == tenant_id:
                return replace(v)
        # Deliberately indistinguishable from "does not exist": a caller must
        # not be able to probe for another tenant's vehicle ids.
        return None

    def status_summary(self, tenant_id: str) -> dict[str, int]:
        # Counts in place rather than via `list`, which would copy every vehicle
        # only to read one field off each.
        summary: dict[str, int] = {}
        for v in self._vehicles:
            if v.tenant_id == tenant_id:
                summary[v.status] = summary.get(v.status, 0) + 1
        return summary
