"""Entrypoint. Fails loudly rather than defaulting to a well-known secret."""

from __future__ import annotations

import os
import sys

import uvicorn

from .app import create_app
from .repository import VehicleRepository, seed_vehicles


def main() -> None:
    secret = os.environ.get("PORTAL_PRINCIPAL_SECRET")
    if not secret:
        print("PORTAL_PRINCIPAL_SECRET is required", file=sys.stderr)
        raise SystemExit(1)

    app = create_app(
        repository=VehicleRepository(seed_vehicles()), principal_secret=secret
    )
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "4002")))


if __name__ == "__main__":
    main()
