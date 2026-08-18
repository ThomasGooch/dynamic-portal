"""Builds one of everything the SDK can produce, and prints it as JSON.

A Python test can only check that the SDK produced what the SDK intended. Only
the protocol package knows whether that is a response the hub accepts — and
nothing in a pytest process can ask it, because the schemas are Zod.

That gap is not theoretical: this SDK shipped a toast carrying `danger`, a
component tone the hub refuses, and every Python test passed. `validate.ts`
reads what this prints and parses it with the real schemas.

Deliberately exercises every component, so a builder that emits a shape the
catalog rejects cannot hide behind the handful a hand-written sample happens
to use.
"""

from __future__ import annotations

import inspect
import json
from typing import Any, Literal, get_args, get_origin, get_type_hints

from portal_sdk import envelopes as env
from portal_sdk import ui, with_id, with_source

_COLUMNS = [{"key": "id", "label": "Id"}]
_ROWS = [{"id": "1"}]

# One valid element per list-shaped prop, because the shapes genuinely differ:
# a `Select.options` entry is `{label, value}` while a `Tabs.tabs` entry is
# `{id, label}`, and guessing produced trees the hub refused.
#
# Keyed by (builder, prop) — the builder name as it appears in `ui.__all__`,
# which is snake_case — falling back to (None, prop) where every component
# agrees. Keying these by the *component* name instead is a silent miss: the
# lookup finds nothing, and before `_sample` learned to refuse that, three
# required props went out as `[]` while this file claimed to supply "one valid
# element per list-shaped prop".
_LIST_SAMPLES: dict[tuple[str | None, str], list[dict[str, Any]]] = {
    (None, "columns"): _COLUMNS,
    (None, "rows"): _ROWS,
    (None, "data"): _ROWS,
    (None, "options"): [{"label": "A", "value": "a"}],
    (None, "tabs"): [{"id": "a", "label": "A"}],
    (None, "series"): [{"key": "count", "label": "Count"}],
    ("key_value_list", "items"): [{"label": "A", "value": "a"}],
    ("menu_button", "items"): [{"label": "A"}],
    ("timeline", "items"): [{"timestamp": "2026-01-01T00:00:00Z", "label": "A"}],
}


def _hints(builder: Any) -> dict[str, Any]:
    """Resolved annotations for one builder.

    `ui.py` carries `from __future__ import annotations`, so every annotation
    is a *string* and `get_args` on it returns nothing. Without resolving them
    first, this file silently filled every enum prop with "x" and swept zero
    enum values — a probe that reported coverage it did not have, which is
    worse than no probe.
    """
    return get_type_hints(builder)


def _literals(annotation: Any) -> tuple[Any, ...]:
    """The members of a Literal, seeing through the `| None` of an optional.

    Every member, not only the string ones. `Heading.level` is
    `Literal[1, 2, 3, 4]`, and keeping to strings dropped it entirely: four
    heading levels never reached the sweep, while the docstring below promised
    "every value of every generated enum". A sweep with a hole in it is worse
    than no sweep, because it is believed.
    """
    if get_origin(annotation) is Literal:
        return get_args(annotation)
    members: list[Any] = []
    for member in get_args(annotation):
        if get_origin(member) is Literal:
            members.extend(get_args(member))
    return tuple(members)


def _sample(annotation: Any, name: str, component: str) -> Any:
    """A value satisfying one generated parameter.

    Reads the resolved annotation rather than guessing, so every enum value is
    reachable from here without this file naming any of them.
    """
    literals = _literals(annotation)
    text = str(annotation)

    if literals:
        return literals[0]
    if "list" in text:
        sample = _LIST_SAMPLES.get((component, name), _LIST_SAMPLES.get((None, name)))
        if sample is None:
            raise KeyError(
                f"no sample element for {component}.{name}. Add one to "
                "_LIST_SAMPLES. Defaulting to [] is what this line used to do, "
                "and an empty list satisfies every element schema there is — so "
                "the prop was reported as covered while nothing about its shape "
                "had been checked."
            )
        return sample
    if "dict" in text:
        return {}
    if "bool" in text:
        return True
    if "int" in text or "float" in text:
        return 1
    return "x"


def every_component() -> list[dict[str, Any]]:
    """One node per component, with every required prop supplied."""
    nodes: list[dict[str, Any]] = []
    for name in ui.__all__:
        builder = getattr(ui, name)
        hints = _hints(builder)
        kwargs = {
            key: _sample(hints.get(key), key, name)
            for key, parameter in inspect.signature(builder).parameters.items()
            if parameter.kind is inspect.Parameter.KEYWORD_ONLY
            and parameter.default is inspect.Parameter.empty
        }
        nodes.append(builder(**kwargs))
    return nodes


def every_enum_value() -> list[dict[str, Any]]:
    """Every value of every generated enum, so none reaches the wire misspelt."""
    nodes: list[dict[str, Any]] = []
    for name in ui.__all__:
        builder = getattr(ui, name)
        hints = _hints(builder)
        signature = inspect.signature(builder)
        required = {
            key: _sample(hints.get(key), key, name)
            for key, parameter in signature.parameters.items()
            if parameter.kind is inspect.Parameter.KEYWORD_ONLY
            and parameter.default is inspect.Parameter.empty
        }
        for key, parameter in signature.parameters.items():
            if parameter.kind is not inspect.Parameter.KEYWORD_ONLY:
                continue
            for value in _literals(hints.get(key)):
                nodes.append(builder(**{**required, key: value}))
    return nodes


# Built once and reported alongside the tree, because "the tree contains a
# Badge somewhere" is not the claim being made. The enum sweep emits a node per
# enum value, so a component dropped from `every_component` still shows up in
# the rendered tree via its own tone/size variants — and a coverage check that
# only looks at the finished tree passes while one builder is never called.
# `validate.ts` compares this list, not the tree, against the catalog.
_COMPONENTS = every_component()
_ENUM_VALUES = every_enum_value()

payload: dict[str, Any] = {
    "componentsBuilt": [node["type"] for node in _COMPONENTS],
    "enumNodesBuilt": len(_ENUM_VALUES),
    "manifest": env.manifest(
        satellite_id="depots",
        display_name="Depot Operations",
        description="Capacity and throughput by depot.",
        audience=["internal"],
        screens=[
            env.screen_descriptor(
                "depots.dashboard", "Depots", audience=["internal"],
                description="Capacity overview.",
            ),
            env.screen_descriptor(
                "depots.detail", "Depot detail", audience=["internal"],
                params=[env.param("id", required=True, description="Depot id")],
            ),
        ],
        actions=[
            env.action_descriptor(
                "depots.close",
                audience=["internal"],
                title="Close depot",
                description="Take a depot out of service.",
                params=[
                    env.action_param("id", "string", required=True, description="Depot id"),
                    env.action_param("reason", "string", choices=["maintenance", "closure"]),
                    env.action_param("force", "boolean"),
                ],
            )
        ],
        nav=[env.nav_entry("depots.dashboard", "Depots", section="Operations", order=30)],
        health_path="/healthz",
    ),
    "screen": env.screen(
        "depots.dashboard",
        "Depots",
        ui.page(
            ui.grid(
                ui.stat_tile(label="Depots", value="4"),
                ui.stat_tile(label="At capacity", value="1", tone="warning"),
                columns=3,
            ),
            with_id("depots-table", ui.table(columns=_COLUMNS, rows=_ROWS)),
            with_source("toolu_probe", ui.stat_tile(label="Cited", value="1")),
            *_COMPONENTS,
            *_ENUM_VALUES,
            title="Depots",
        ),
        breadcrumbs=[env.crumb("Depots")],
        ttl_seconds=30,
    ),
    "actions": {
        "ok": env.ok(message="Depot updated."),
        "okBare": env.ok(),
        "okInfo": env.ok(message="Queued.", level="info"),
        "okWarning": env.ok(message="Partially applied.", level="warning"),
        "okPatch": env.ok(
            message="Updated.",
            patch=[env.patch("depots-table", ui.table(columns=_COLUMNS, rows=_ROWS))],
        ),
        "okNavigate": env.ok(navigate=env.navigate("orders.detail", {"id": "1"}, satellite_id="orders")),
        "invalid": env.invalid({"name": "Already in use"}),
        "invalidToast": env.invalid({"name": "Already in use"}, message="Check the form."),
        "failed": env.failed("The depot service is unavailable."),
    },
}

print(json.dumps(payload))
