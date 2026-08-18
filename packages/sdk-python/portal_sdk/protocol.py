"""The protocol's constants, as the hub defines them.

GENERATED FROM @portal/protocol — DO NOT EDIT.

Run `pnpm sdk:python` to regenerate; `pnpm sdk:check` fails if this is stale.

Everything here was previously retyped into Python by hand, which is how a
toast went out carrying a component tone the hub refuses. A vocabulary copied
by hand is a vocabulary that drifts.
"""

from __future__ import annotations

from typing import Literal

#: The version this SDK emits.
PROTOCOL = "1.1"

#: Toast levels. Note `error`, not `danger` — `danger` is a component tone.
ToastLevel = Literal["success", "info", "warning", "error"]

#: What an action reports back.
ActionOutcome = Literal["ok", "error", "validation"]

#: Who a satellite, screen or action is visible to. Default-deny: absent means
#: internal, and external must always be stated.
Audience = Literal["internal", "external"]

#: The components whose schema declares `source`. Only these can carry a
#: citation: every component schema is strict, so a citation on anything else
#: is a node the hub refuses rather than one it merely ignores.
CITABLE = frozenset(
    {
        "StatTile",
        "KeyValueList",
        "Table",
        "Chart",
    }
)
