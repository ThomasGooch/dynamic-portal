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


def _find(node: dict, type_: str) -> dict | None:
    if node.get("type") == type_:
        return node
    for child in node.get("children") or []:
        found = _find(child, type_)
        if found:
            return found
    return None
