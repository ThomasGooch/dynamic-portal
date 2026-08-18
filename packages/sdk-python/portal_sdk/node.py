"""The node the builders produce, and the one rule they enforce.

Hand-written, unlike ``ui.py``: this is the runtime the generated surface sits
on, and it changes when the *protocol* changes rather than when the catalog
does.
"""

from __future__ import annotations

from typing import Any, TypedDict

from .protocol import CITABLE


class Source(TypedDict):
    toolCallId: str


class Node(TypedDict, total=False):
    """A UI node, shaped exactly as the wire format.

    ``total=False`` because every field except ``type`` is optional, and the
    builders omit rather than null them — a satellite that sends
    ``"props": null`` is sending something the hub has to reject, and the
    cheapest way never to do that is never to construct it.
    """

    type: str
    id: str
    props: dict[str, Any]
    children: list["Node"]
    source: Source


def build(component: str, children: tuple[Node, ...], props: dict[str, Any]) -> Node:
    """Assembles a node, dropping props that were never set.

    A prop left at its default is absent from the payload, not present and
    null. The distinction matters: the catalog marks optional props optional,
    not nullable, so an explicit null fails validation at the hub and an
    omission is simply the default.
    """
    node: Node = {"type": component}

    supplied = {key: value for key, value in props.items() if value is not None}
    if supplied:
        node["props"] = supplied
    if children:
        node["children"] = list(children)

    return node


def with_id(node_id: str, node: Node) -> Node:
    """Names a node so an action's ``patch`` can address it later."""
    return {**node, "id": node_id}


def with_source(tool_call_id: str, node: Node) -> Node:
    """Marks where a number came from.

    A *prop*, unlike ``id``. Grounding reads ``props.source`` when it decides
    whether a number is cited, and every provenance mark the renderer draws
    reads the same place. The node also has a top-level ``source`` field that
    nothing reads; writing there is how the TypeScript SDK got this wrong, and
    a citation nothing can see is worse than none at all.

    Satellites rarely need this — they *are* the source. It exists because a
    satellite composing on an agent's behalf has to say where a figure came
    from.
    """
    if node["type"] not in CITABLE:
        raise ValueError(
            f"{node['type']} cannot carry a source. Only "
            f"{', '.join(sorted(CITABLE))} declare one, because only they "
            "display data a citation would refer to."
        )
    props = {**node.get("props", {}), "source": {"toolCallId": tool_call_id}}
    return {**node, "props": props}
