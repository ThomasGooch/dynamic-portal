"""The responses a satellite gives, and nothing else.

PUP is three endpoints. This module is the other half of the SDK's job: the
builders make a valid *tree*, and these make a valid envelope around it. A
satellite using both never assembles a response by hand, which is where the
protocol version, the key names and the outcome vocabulary go wrong.

Hand-written rather than generated: these track the *protocol*, which changes
on its own schedule, while ``ui`` tracks the catalog.
"""

from __future__ import annotations

from typing import Any, Literal

from .node import Node

#: The version this SDK emits. The hub supports the current major minus two,
#: so a satellite pinned to an older minor keeps working — but there is no
#: reason to emit one.
PROTOCOL = "1.1"

Audience = Literal["internal", "external"]
ToastLevel = Literal["success", "info", "warning", "danger"]


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
    body: dict[str, Any] = {"protocol": PROTOCOL, "outcome": "ok"}
    if message is not None:
        body["toast"] = {"level": level, "message": message}
    if patch is not None:
        body["patch"] = patch
    if navigate is not None:
        body["navigate"] = navigate
    return body


def invalid(field_errors: dict[str, str], *, message: str | None = None) -> dict[str, Any]:
    """The input was wrong, and here is which field.

    Distinct from :func:`failed` deliberately: this renders inline against the
    offending fields and is the user's to fix. A failure is the system's.
    """
    body: dict[str, Any] = {
        "protocol": PROTOCOL,
        "outcome": "validation",
        "fieldErrors": field_errors,
    }
    if message is not None:
        body["toast"] = {"level": "warning", "message": message}
    return body


def failed(message: str) -> dict[str, Any]:
    """The action did not work, and it was not the caller's doing."""
    return {
        "protocol": PROTOCOL,
        "outcome": "error",
        "toast": {"level": "danger", "message": message},
    }


def patch(target_id: str, ui: Node) -> dict[str, Any]:
    """Replaces one named node. Pair with :func:`portal_sdk.with_id`."""
    return {"targetId": target_id, "ui": ui}


def navigate(screen_id: str, params: dict[str, str] | None = None) -> dict[str, Any]:
    """Sends the user to another screen after an action."""
    return {"screenId": screen_id} if params is None else {"screenId": screen_id, "params": params}


def manifest(
    *,
    satellite_id: str,
    display_name: str,
    audience: list[Audience],
    screens: list[dict[str, Any]],
    actions: list[dict[str, Any]] | None = None,
    description: str | None = None,
    nav: list[dict[str, Any]] | None = None,
    mcp_url: str | None = None,
    health_path: str | None = None,
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
        "audience": audience,
        "screens": screens,
        "actions": actions if actions is not None else [],
    }
    for key, value in (
        ("description", description),
        ("nav", nav),
        ("mcpUrl", mcp_url),
        ("healthPath", health_path),
    ):
        if value is not None:
            body[key] = value
    return body


def screen_descriptor(
    screen_id: str,
    title: str,
    *,
    audience: list[Audience],
    description: str | None = None,
    params: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """One entry in a manifest's ``screens``."""
    entry: dict[str, Any] = {"id": screen_id, "title": title, "audience": audience}
    if description is not None:
        entry["description"] = description
    if params is not None:
        entry["params"] = params
    return entry


def param(name: str, *, required: bool = False, description: str | None = None) -> dict[str, Any]:
    """A screen or action parameter."""
    entry: dict[str, Any] = {"name": name, "required": required}
    if description is not None:
        entry["description"] = description
    return entry


def nav_entry(screen_id: str, label: str, *, section: str, order: int) -> dict[str, Any]:
    """Where this satellite appears in the hub's navigation."""
    return {"screenId": screen_id, "label": label, "section": section, "order": order}
