"""Portal SDK for Python satellites.

Two halves. ``ui`` is generated from the hub's component catalog and cannot
drift from it; everything else is hand-written and tracks the protocol.

    from portal_sdk import envelopes, ui

    def dashboard(vehicles):
        return envelopes.screen(
            "fleet.dashboard",
            "Fleet",
            ui.page(
                ui.grid(
                    ui.stat_tile(label="Vehicles", value=str(len(vehicles))),
                    columns=3,
                ),
            ),
        )
"""

from . import envelopes, protocol, ui
from .node import Node, visible_when, with_id, with_source
from .protocol import PROTOCOL

__all__ = [
    "PROTOCOL",
    "Node",
    "envelopes",
    "protocol",
    "ui",
    "visible_when",
    "with_id",
    "with_source",
]
