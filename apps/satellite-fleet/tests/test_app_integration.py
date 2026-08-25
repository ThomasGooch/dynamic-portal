"""Integration tier: a real uvicorn server on a real socket.

Deliberately not FastAPI's in-process ``TestClient``. The Node satellite's
integration tier binds an ephemeral port and speaks HTTP over it, and this tier
matches that definition so "integration" means the same thing in both languages.
"""

import socket
import threading
import time
from collections.abc import Iterator

import httpx
import pytest
import uvicorn

from satellite_fleet.app import create_app
from satellite_fleet.principal import Principal, sign_principal
from satellite_fleet.repository import VehicleRepository, seed_vehicles

SECRET = "integration-secret"


def principal(**over: object) -> Principal:
    base = dict(
        sub="dana@acme.example",
        tenant_id="acme",
        audience="internal",
        scopes=("fleet.read",),
        # engineering is one of fleet's offered roles, so the default probe
        # passes the satellite's role gate; override to test refusal.
        roles=("engineering",),
    )
    base.update(over)
    return Principal(**base)  # type: ignore[arg-type]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture(scope="module")
def repository() -> VehicleRepository:
    return VehicleRepository(seed_vehicles())


@pytest.fixture(scope="module")
def base_url(repository: VehicleRepository) -> Iterator[str]:
    port = _free_port()
    app = create_app(repository=repository, principal_secret=SECRET)
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    deadline = time.monotonic() + 20
    while not server.started:
        if time.monotonic() > deadline:
            raise RuntimeError("uvicorn did not start")
        time.sleep(0.05)

    yield f"http://127.0.0.1:{port}"

    server.should_exit = True
    thread.join(timeout=10)


@pytest.fixture(scope="module")
def client(base_url: str) -> Iterator[httpx.Client]:
    with httpx.Client(base_url=base_url, timeout=10) as c:
        yield c


def auth(p: Principal | None = None) -> dict[str, str]:
    return {"authorization": f"Bearer {sign_principal(p or principal(), SECRET)}"}


pytestmark = pytest.mark.integration


class TestProtocolConformance:
    def test_health(self, client: httpx.Client) -> None:
        res = client.get("/healthz")
        assert res.status_code == 200
        assert res.json()["status"] == "ok"

    def test_manifest_declares_no_mcp_endpoint(self, client: httpx.Client) -> None:
        # This satellite deliberately ships no MCP server: it is the case that
        # proves the hub's PUP-to-MCP shim has something to do.
        manifest = client.get("/portal/manifest").json()
        assert manifest["satelliteId"] == "fleet"
        assert "mcpUrl" not in manifest

    def test_manifest_is_internal_only_by_default(self, client: httpx.Client) -> None:
        assert client.get("/portal/manifest").json()["audience"] == ["internal"]

    def test_dashboard_screen_shape(self, client: httpx.Client) -> None:
        body = client.get("/portal/screens/fleet.dashboard", headers=auth()).json()
        assert body["screen"]["id"] == "fleet.dashboard"
        assert body["ui"]["type"] == "Page"


class TestAuthentication:
    def test_refuses_unauthenticated(self, client: httpx.Client) -> None:
        assert client.get("/portal/screens/fleet.dashboard").status_code == 401

    def test_refuses_wrong_secret(self, client: httpx.Client) -> None:
        forged = sign_principal(principal(), "wrong-secret")
        res = client.get(
            "/portal/screens/fleet.dashboard",
            headers={"authorization": f"Bearer {forged}"},
        )
        assert res.status_code == 401

    def test_accepts_lowercase_scheme(self, client: httpx.Client) -> None:
        # RFC 7235: the auth-scheme is case-insensitive.
        token = sign_principal(principal(), SECRET)
        res = client.get(
            "/portal/screens/fleet.dashboard",
            headers={"authorization": f"bearer {token}"},
        )
        assert res.status_code == 200

    def test_manifest_needs_no_principal(self, client: httpx.Client) -> None:
        assert client.get("/portal/manifest").status_code == 200


class TestTenantIsolation:
    """The hub is absent from every request below, which is the entire point.

    If authorization lived only in the hub, all of these would fail.
    """

    def test_two_tenants_see_disjoint_vehicles(self, client: httpx.Client) -> None:
        def ids(tenant: str) -> set[str]:
            body = client.get(
                "/portal/screens/fleet.dashboard",
                headers=auth(principal(tenant_id=tenant)),
            ).json()
            table = _find(body["ui"], "Table")
            assert table is not None
            return {row["id"] for row in table["props"]["rows"]}

        acme, globex = ids("acme"), ids("globex")
        assert acme and globex
        assert not (acme & globex)

    def test_rows_never_carry_tenant_id(self, client: httpx.Client) -> None:
        body = client.get("/portal/screens/fleet.dashboard", headers=auth()).json()
        table = _find(body["ui"], "Table")
        assert table is not None
        assert all("tenantId" not in row for row in table["props"]["rows"])

    def test_foreign_vehicle_404s_rather_than_403(
        self, client: httpx.Client, repository: VehicleRepository
    ) -> None:
        foreign = repository.list("globex")[0]
        res = client.get(
            f"/portal/screens/fleet.detail?id={foreign.id}", headers=auth()
        )
        assert res.status_code == 404

    def test_external_audience_is_refused(self, client: httpx.Client) -> None:
        # The manifest declares internal-only; a validly signed external
        # principal must still be refused.
        res = client.get(
            "/portal/screens/fleet.dashboard",
            headers=auth(principal(audience="external")),
        )
        assert res.status_code == 403

    def test_missing_scope_is_refused(self, client: httpx.Client) -> None:
        res = client.get(
            "/portal/screens/fleet.dashboard", headers=auth(principal(scopes=()))
        )
        assert res.status_code == 403

    def test_every_role_may_read_the_satellite(self, client: httpx.Client) -> None:
        # This satellite declares no role ceiling: reaching it is not what roles
        # decide. A finance-only principal — which the previous policy refused
        # outright — gets the dashboard, and what differs is the sections on it.
        # Replaces a test that asserted 403 here; that assertion WAS the bug.
        for role in ("leadership", "engineering", "finance", "platform"):
            res = client.get(
                "/portal/screens/fleet.dashboard",
                headers=auth(principal(roles=(role,))),
            )
            assert res.status_code == 200, f"{role} was refused the dashboard"

    def test_a_roleless_principal_still_reads_the_shared_dashboard(
        self, client: httpx.Client
    ) -> None:
        # Holding no role at all must not be the same as being refused: the
        # shared half of the screen is everyone's, and only the additions are
        # earned. Guards the reading of "absent roles" as "nobody".
        res = client.get(
            "/portal/screens/fleet.dashboard", headers=auth(principal(roles=()))
        )
        assert res.status_code == 200
        ui = res.json()["ui"]
        assert _find(ui, "Table") is not None, "the shared vehicles table went missing"


class TestRoleSections:
    """The role-specific half of the dashboard: additive, and never subtractive."""

    def _ids(self, client: httpx.Client, roles: tuple[str, ...]) -> set[str]:
        res = client.get(
            "/portal/screens/fleet.dashboard", headers=auth(principal(roles=roles))
        )
        assert res.status_code == 200
        found: set[str] = set()

        def walk(node: dict) -> None:
            node_id = node.get("id")
            if isinstance(node_id, str):
                found.add(node_id)
            for child in node.get("children") or []:
                walk(child)

        walk(res.json()["ui"])
        return found

    def test_finance_gets_a_graph_nobody_else_does(self, client: httpx.Client) -> None:
        assert "fleet-finance-chart" in self._ids(client, ("finance",))
        for other in ("engineering", "platform", "leadership"):
            assert "fleet-finance-chart" not in self._ids(client, (other,))

    def test_platform_gets_the_estate_metrics(self, client: httpx.Client) -> None:
        assert "fleet-platform-metrics" in self._ids(client, ("platform",))
        for other in ("finance", "engineering", "leadership"):
            assert "fleet-platform-metrics" not in self._ids(client, (other,))

    def test_engineering_gets_the_service_queue(self, client: httpx.Client) -> None:
        assert "fleet-service-queue" in self._ids(client, ("engineering",))
        for other in ("finance", "platform", "leadership"):
            assert "fleet-service-queue" not in self._ids(client, (other,))

    def test_the_shared_screen_survives_every_role(self, client: httpx.Client) -> None:
        # The point of the change: role sections ADD. Whatever a role holds,
        # the vehicles table everyone had is still there. A regression here
        # means someone turned an addition into a replacement.
        for roles in ((), ("finance",), ("engineering",), ("platform",),
                      ("finance", "engineering", "platform")):
            assert "fleet-table" in self._ids(client, roles), f"lost for {roles}"

    def test_holding_every_role_gets_every_section(self, client: httpx.Client) -> None:
        ids = self._ids(client, ("finance", "engineering", "platform"))
        assert {"fleet-finance-chart", "fleet-service-queue", "fleet-table"} <= ids


def _find(node: dict, type_: str) -> dict | None:
    if node.get("type") == type_:
        return node
    for child in node.get("children") or []:
        found = _find(child, type_)
        if found:
            return found
    return None
