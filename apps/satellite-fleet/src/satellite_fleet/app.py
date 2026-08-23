"""The satellite's HTTP surface: PUP screens plus health.

Exposed as a factory rather than a module-level singleton so tests can inject a
fresh repository and bind an ephemeral port — the reason the integration suite
needs no docker-compose dependency.
"""

# NOTE: deliberately no `from __future__ import annotations` here.
#
# PEP 563 turns every annotation into a string, and FastAPI resolves those with
# `get_type_hints()` against *module* globals. The `Authed` alias below is local
# to `create_app` (it must be — `authenticate` closes over `principal_secret`),
# so under PEP 563 it is unresolvable: FastAPI never sees the `Depends`, treats
# `principal` as a query parameter, and every authenticated route answers 422
# before the auth code runs. Evaluating annotations eagerly keeps the alias
# visible in the enclosing scope.
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from .principal import InvalidPrincipalError, Principal, verify_principal
from .repository import VehicleRepository
from .screens import PROTOCOL, dashboard_screen, detail_screen, manifest

_DECLARED_AUDIENCE = frozenset(manifest()["audience"])
_DECLARED_ROLES: tuple[str, ...] = tuple(manifest().get("roles", ()))
_READ_SCOPE = "fleet.read"


def create_app(*, repository: VehicleRepository, principal_secret: str) -> FastAPI:
    # `openapi_url=None` as well as the two doc UIs: turning off /docs and
    # /redoc alone leaves /openapi.json served unauthenticated, which publishes
    # the whole route surface. The manifest is the satellite's declaration; the
    # OpenAPI schema is internal detail.
    app = FastAPI(
        title="satellite-fleet", docs_url=None, redoc_url=None, openapi_url=None
    )

    def authenticate(
        authorization: Annotated[str | None, Header()] = None,
    ) -> Principal:
        # RFC 7235: the auth-scheme is case-insensitive, so `bearer <token>` is
        # a legal request and must not be read as "no credentials at all".
        header = authorization or ""
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise HTTPException(status_code=401, detail="missing bearer token")
        try:
            principal = verify_principal(token, principal_secret)
        except InvalidPrincipalError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc

        # Default-deny audience, enforced here rather than assumed of the hub.
        if principal.audience not in _DECLARED_AUDIENCE:
            raise HTTPException(status_code=403, detail="audience not permitted")
        if _READ_SCOPE not in principal.scopes:
            raise HTTPException(status_code=403, detail=f"missing scope {_READ_SCOPE}")
        # Roles gate internal principals only — external partners are governed by
        # audience + scope + the public projection (this satellite ships none).
        # Any-of, re-checked here as defense in depth behind the hub.
        if (
            _DECLARED_ROLES
            and principal.audience == "internal"
            and not any(role in _DECLARED_ROLES for role in principal.roles)
        ):
            raise HTTPException(status_code=403, detail="role not permitted")
        return principal

    Authed = Annotated[Principal, Depends(authenticate)]

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok", "protocol": PROTOCOL}

    # The manifest describes capabilities, not data, so it needs no principal.
    @app.get("/portal/manifest")
    def get_manifest() -> dict:
        return manifest()

    @app.get("/portal/screens/fleet.dashboard")
    def dashboard(principal: Authed) -> dict:
        tenant = principal.tenant_id
        return dashboard_screen(
            repository.list(tenant), repository.status_summary(tenant)
        )

    @app.get("/portal/screens/fleet.detail")
    def detail(principal: Authed, id: Annotated[str, Query()] = "") -> dict:
        vehicle = repository.get(principal.tenant_id, id)
        # 404 rather than 403 on purpose: a 403 would confirm that a vehicle
        # belonging to another tenant exists, which is itself a disclosure.
        if vehicle is None:
            raise HTTPException(status_code=404, detail="vehicle not found")
        return detail_screen(vehicle)

    @app.get("/portal/screens/{screen_id}")
    def unknown_screen(screen_id: str, principal: Authed) -> dict:
        raise HTTPException(status_code=404, detail="unknown screen")

    @app.exception_handler(Exception)
    async def unhandled(_request: Request, exc: Exception) -> JSONResponse:
        # Never surface tracebacks or internal detail to a caller.
        return JSONResponse(status_code=500, content={"error": "internal error"})

    return app
