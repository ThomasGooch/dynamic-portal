"""The responses a satellite gives, and nothing else.

PUP is three endpoints. This module is the other half of the SDK's job: the
builders make a valid *tree*, and these make a valid envelope around it. A
satellite using both never assembles a response by hand, which is where the
protocol version, the key names and the outcome vocabulary go wrong.

The *shapes* here are hand-written, because they track the protocol's envelope
structure. The *vocabulary* is not: levels, outcomes, audiences, parameter
types and the version come from :mod:`portal_sdk.protocol`, which is generated. Retyping them by hand
is how a toast went out carrying ``danger`` — a component tone the hub refuses
— and a mistake no satellite here could catch, because none ships an action.
"""

from __future__ import annotations

from typing import Any

from .node import Node
from .protocol import PROTOCOL, Audience, ParamType, Role, ToastLevel

__all__ = [
    "PROTOCOL",
    "Audience",
    "ParamType",
    "Role",
    "ToastLevel",
    "action_descriptor",
    "action_param",
    "crumb",
    "failed",
    "invalid",
    "manifest",
    "nav_entry",
    "navigate",
    "ok",
    "param",
    "patch",
    "screen",
    "screen_descriptor",
]


def screen(
    screen_id: str,
    title: str,
    ui: Node,
    *,
    breadcrumbs: list[dict[str, Any]] | None = None,
    ttl_seconds: int | None = None,
    etag: str | None = None,
) -> dict[str, Any]:
    """A ``GET /portal/screens/{id}`` response."""
    descriptor: dict[str, Any] = {"id": screen_id, "title": title}
    if breadcrumbs is not None:
        descriptor["breadcrumbs"] = breadcrumbs

    body: dict[str, Any] = {"protocol": PROTOCOL, "screen": descriptor, "ui": ui}

    meta = {
        key: value
        for key, value in (("ttlSeconds", ttl_seconds), ("etag", etag))
        if value is not None
    }
    if meta:
        body["meta"] = meta
    return body


def crumb(label: str, screen_id: str | None = None) -> dict[str, Any]:
    """One breadcrumb. The last one is the current screen and has no link."""
    return {"label": label} if screen_id is None else {"label": label, "screenId": screen_id}


def _toast(level: ToastLevel, message: str) -> dict[str, Any]:
    """A toast, or a refusal.

    ``ToastSchema.message`` is ``.min(1)``, so an empty or blank message is an
    envelope the hub rejects outright — and a toast nobody can read is not a
    message anyway.
    """
    if not message.strip():
        raise ValueError(
            "a toast needs a message; the hub rejects an empty one, and a "
            "notification with nothing in it tells the reader nothing."
        )
    return {"level": level, "message": message}


def _audience(audience: list[Audience]) -> list[Audience]:
    """Refuses an empty audience list.

    Empty is not default-deny. ``AudienceListSchema`` is ``.nonempty()``, so an
    empty list makes the hub reject the whole manifest — taking every screen
    and action with it. Declare ``["internal"]`` explicitly.
    """
    if not audience:
        raise ValueError(
            'audience must not be empty; declare ["internal"] explicitly. An '
            "empty list is not default-deny — the hub refuses the manifest."
        )
    return audience


def ok(
    *,
    message: str | None = None,
    level: ToastLevel = "success",
    patch: list[dict[str, Any]] | None = None,
    navigate: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """An action that worked.

    ``patch`` says what should now be true without the hub re-fetching the
    screen; ``navigate`` sends the user elsewhere. An action that only needs
    to say "done" says only that.
    """
    if message is None and level != "success":
        # The level is only read when there is a message, so this asks for a
        # report and silently gets none — with nothing at the call site to say
        # so. The default level with no message stays legal.
        raise ValueError(
            f'level="{level}" has no effect without a message: an action that '
            "says nothing shows no toast. Pass a message, or drop the level."
        )

    body: dict[str, Any] = {"protocol": PROTOCOL, "outcome": "ok"}
    if message is not None:
        body["toast"] = _toast(level, message)
    if patch is not None:
        body["patch"] = patch
    if navigate is not None:
        body["navigate"] = navigate
    return body


def invalid(field_errors: dict[str, str], *, message: str | None = None) -> dict[str, Any]:
    """The input was wrong, and here is which field.

    Distinct from :func:`failed` deliberately: this renders inline against the
    offending fields and is the user's to fix. A failure is the system's.

    The map has to be non-empty, and this raises rather than letting the hub
    say so: the protocol rejects a ``validation`` outcome with nothing to
    attach a message to, and a refusal here names the line that built it.
    """
    if not field_errors:
        raise ValueError(
            'outcome "validation" must carry at least one field error; '
            'use failed() for a failure with no field to attach to'
        )

    body: dict[str, Any] = {
        "protocol": PROTOCOL,
        "outcome": "validation",
        "fieldErrors": field_errors,
    }
    if message is not None:
        body["toast"] = _toast("warning", message)
    return body


def failed(message: str) -> dict[str, Any]:
    """The action did not work, and it was not the caller's doing."""
    return {
        "protocol": PROTOCOL,
        "outcome": "error",
        "toast": _toast("error", message),
    }


def patch(target_id: str, ui: Node) -> dict[str, Any]:
    """Replaces one named node. Pair with :func:`portal_sdk.with_id`."""
    return {"targetId": target_id, "ui": ui}


def navigate(
    screen_id: str,
    params: dict[str, str] | None = None,
    *,
    satellite_id: str | None = None,
) -> dict[str, Any]:
    """Sends the user to another screen after an action.

    ``satellite_id`` is what lets this leave the satellite that handled the
    action. Omitted, the hub resolves the screen against the current one —
    right for the common case, and unable to express "now go to the order this
    shipment belongs to".
    """
    body: dict[str, Any] = {"screenId": screen_id}
    if satellite_id is not None:
        body["satelliteId"] = satellite_id
    if params is not None:
        body["params"] = params
    return body


def action_param(
    name: str,
    param_type: ParamType,
    *,
    required: bool = False,
    description: str | None = None,
    choices: list[str] | None = None,
) -> dict[str, Any]:
    """One entry in an action's ``params``.

    Distinct from :func:`param`, which describes a *screen* parameter and has
    no type. An action parameter must state one: the MCP gateway turns these
    into a tool's input schema, and a parameter with no type is one a model
    cannot fill in.

    ``choices`` becomes ``enum`` on the wire — an agent picks from the list
    rather than inventing a value.
    """
    entry: dict[str, Any] = {"name": name, "type": param_type, "required": required}
    if description is not None:
        entry["description"] = description
    if choices is not None:
        if not choices:
            raise ValueError(
                "choices must not be empty; the hub rejects an empty enum, and "
                "a list of no options is not a choice. Omit it instead."
            )
        if param_type not in ("string", "string[]"):
            # `ActionParamSchema` refuses this: the choices are strings, so on a
            # number or a boolean they describe a parameter no value can
            # satisfy — an action that reads as callable and is not one. On a
            # `string[]` they are meaningful and constrain each *entry*, which
            # is why that one is allowed through.
            raise ValueError(
                f'choices are only meaningful on a string parameter, not '
                f'{param_type}: the values are strings, so a {param_type} '
                "parameter could never match one. Drop the choices, or make "
                'the parameter a "string" or a "string[]".'
            )
        entry["enum"] = choices
    return entry


def action_descriptor(
    action_id: str,
    *,
    audience: list[Audience],
    roles: list[Role] | None = None,
    title: str | None = None,
    description: str | None = None,
    params: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """One entry in a manifest's ``actions``.

    An action stays uncallable by the gateway until it declares what it takes,
    so ``params`` is how an agent reaches it at all. Build them with
    :func:`action_param`, not :func:`param`.
    """
    entry: dict[str, Any] = {"id": action_id, "audience": _audience(audience)}
    if roles is not None:
        entry["roles"] = roles
    if title is not None:
        entry["title"] = title
    if description is not None:
        entry["description"] = description
    if params is not None:
        entry["params"] = params
    return entry


def manifest(
    *,
    satellite_id: str,
    display_name: str,
    audience: list[Audience],
    roles: list[Role] | None = None,
    screens: list[dict[str, Any]],
    actions: list[dict[str, Any]] | None = None,
    description: str | None = None,
    nav: list[dict[str, Any]] | None = None,
    mcp_url: str | None = None,
    health_path: str | None = None,
    summary_screen_id: str | None = None,
) -> dict[str, Any]:
    """A ``GET /portal/manifest`` response.

    ``audience`` defaults to nothing and must be stated. Every screen and
    action must declare an audience that is a *subset* of this one — the hub
    rejects a manifest where a screen is wider than the satellite, so a
    satellite cannot widen its own reach by forgetting.
    """
    body: dict[str, Any] = {
        "protocol": PROTOCOL,
        "satelliteId": satellite_id,
        "displayName": display_name,
        "audience": _audience(audience),
        "screens": screens,
        "actions": actions if actions is not None else [],
    }
    for key, value in (
        ("roles", roles),
        ("description", description),
        ("nav", nav),
        ("mcpUrl", mcp_url),
        ("healthPath", health_path),
        # `is not None`, like every other field here: an empty screen id is a
        # mistake worth failing on at the hub, not one to quietly drop the
        # summary for and leave a card with no figures and nothing to explain it.
        (
            "summary",
            {"screenId": summary_screen_id} if summary_screen_id is not None else None,
        ),
    ):
        if value is not None:
            body[key] = value
    return body


def screen_descriptor(
    screen_id: str,
    title: str,
    *,
    audience: list[Audience],
    roles: list[Role] | None = None,
    description: str | None = None,
    params: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """One entry in a manifest's ``screens``."""
    entry: dict[str, Any] = {"id": screen_id, "title": title, "audience": _audience(audience)}
    if roles is not None:
        entry["roles"] = roles
    if description is not None:
        entry["description"] = description
    if params is not None:
        entry["params"] = params
    return entry


def param(name: str, *, required: bool = False, description: str | None = None) -> dict[str, Any]:
    """A *screen* parameter.

    Not an action parameter, despite what this said before ``action_param``
    existed. ``ActionParamSchema`` is ``.strict()`` and requires ``type``, so
    putting one of these in an action's ``params`` gets the whole manifest
    rejected — every screen and action with it. Use :func:`action_param`.
    """
    entry: dict[str, Any] = {"name": name, "required": required}
    if description is not None:
        entry["description"] = description
    return entry


def nav_entry(
    screen_id: str,
    label: str,
    *,
    section: str | None = None,
    order: int | None = None,
) -> dict[str, Any]:
    """Where this satellite appears in the hub's navigation.

    Both ``section`` and ``order`` are optional, as they are in the manifest
    schema: a satellite with one entry has nothing to group it with and
    nothing to order it against.
    """
    entry: dict[str, Any] = {"screenId": screen_id, "label": label}
    if section is not None:
        entry["section"] = section
    if order is not None:
        entry["order"] = order
    return entry
