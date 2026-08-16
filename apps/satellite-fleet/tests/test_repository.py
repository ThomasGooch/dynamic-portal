import pytest

from satellite_fleet.repository import VehicleRepository, seed_vehicles


@pytest.fixture
def repo() -> VehicleRepository:
    return VehicleRepository(seed_vehicles())


def test_lists_only_the_calling_tenants_vehicles(repo: VehicleRepository) -> None:
    acme = repo.list("acme")
    assert acme
    assert all(v.tenant_id == "acme" for v in acme)


def test_tenants_have_disjoint_result_sets(repo: VehicleRepository) -> None:
    acme_ids = {v.id for v in repo.list("acme")}
    globex_ids = {v.id for v in repo.list("globex")}
    assert globex_ids
    assert not (acme_ids & globex_ids)


# Returning None rather than the record — and, at the HTTP layer, 404 rather
# than 403 — matters: a 403 would confirm that someone else's vehicle id exists,
# which is itself a disclosure.
def test_does_not_return_another_tenants_vehicle(repo: VehicleRepository) -> None:
    foreign = repo.list("globex")[0]
    assert repo.get("acme", foreign.id) is None


def test_returns_the_tenants_own_vehicle(repo: VehicleRepository) -> None:
    own = repo.list("acme")[0]
    assert repo.get("acme", own.id) is not None


def test_unknown_tenant_sees_nothing(repo: VehicleRepository) -> None:
    assert repo.list("no-such-tenant") == []


def test_instances_are_isolated_so_state_cannot_leak_between_tests() -> None:
    a = VehicleRepository(seed_vehicles())
    a.list("acme")[0].status = "retired"
    fresh = VehicleRepository(seed_vehicles())
    assert fresh.list("acme")[0].status != "retired"


def test_maintenance_summary_counts_only_the_tenants_vehicles(
    repo: VehicleRepository,
) -> None:
    summary = repo.status_summary("acme")
    assert sum(summary.values()) == len(repo.list("acme"))
