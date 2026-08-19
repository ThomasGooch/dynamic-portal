"""Typed builders for Portal UI screens.

GENERATED FROM THE CATALOG — DO NOT EDIT.

Run `pnpm sdk:python` to regenerate. CI regenerates and fails if this file
differs, so it cannot drift from the vocabulary the hub actually validates.

Catalog version 1.0, 34 components.

Every builder takes its children positionally and its props by keyword::

    from portal_sdk import ui

    ui.page(
        ui.grid(
            ui.stat_tile(label="Vehicles", value="12"),
            ui.stat_tile(label="In maintenance", value="3", tone="warning"),
            columns=3,
        ),
        title="Fleet",
    )

A misspelled prop is a `TypeError` where you wrote it, naming the component —
not a rejected response from the hub at request time, in an environment you
cannot see. A wrong enum value is flagged by your type checker before it runs.
"""

from __future__ import annotations

from typing import Any, Literal

from .node import Node, build

__all__ = [
    "page",
    "section",
    "stack",
    "grid",
    "card",
    "tabs",
    "divider",
    "modal",
    "heading",
    "text",
    "badge",
    "stat_tile",
    "key_value_list",
    "table",
    "chart",
    "alert",
    "empty_state",
    "timeline",
    "form",
    "text_field",
    "text_area",
    "number_field",
    "select",
    "multi_select",
    "date_field",
    "date_range",
    "checkbox",
    "switch",
    "radio_group",
    "file_upload",
    "hidden",
    "button",
    "link",
    "menu_button",
]


def page(
    *children: Node,
    title: str | None = None,
) -> Node:
    """Page.

    title (optional)
    """
    return build(
        "Page",
        children,
        {
            "title": title,
        },
    )


def section(
    *children: Node,
    title: str | None = None,
    description: str | None = None,
    collapsible: bool | None = None,
) -> Node:
    """Section.

    title (optional)
    description (optional)
    collapsible (optional)
    """
    return build(
        "Section",
        children,
        {
            "title": title,
            "description": description,
            "collapsible": collapsible,
        },
    )


def stack(
    *children: Node,
    direction: Literal["row", "column"] | None = None,
    gap: Literal["none", "xs", "sm", "md", "lg"] | None = None,
    align: Literal["start", "center", "end"] | None = None,
    wrap: bool | None = None,
) -> Node:
    """Stack.

    direction (optional)
    gap (optional)
    align (optional)
    wrap (optional)
    """
    return build(
        "Stack",
        children,
        {
            "direction": direction,
            "gap": gap,
            "align": align,
            "wrap": wrap,
        },
    )


def grid(
    *children: Node,
    columns: int,
    gap: Literal["none", "xs", "sm", "md", "lg"] | None = None,
) -> Node:
    """Grid.

    columns
    gap (optional)
    """
    return build(
        "Grid",
        children,
        {
            "columns": columns,
            "gap": gap,
        },
    )


def card(
    *children: Node,
    title: str | None = None,
    tone: Literal["neutral", "muted", "info", "success", "warning", "danger"] | None = None,
) -> Node:
    """Card.

    title (optional)
    tone (optional)
    """
    return build(
        "Card",
        children,
        {
            "title": title,
            "tone": tone,
        },
    )


def tabs(
    *children: Node,
    tabs: list[dict[str, Any]],
    activeId: str | None = None,
) -> Node:
    """Tabs.

    tabs
    activeId (optional)
    """
    return build(
        "Tabs",
        children,
        {
            "tabs": tabs,
            "activeId": activeId,
        },
    )


def divider(
    *children: Node,
    spacing: Literal["none", "xs", "sm", "md", "lg"] | None = None,
) -> Node:
    """Divider.

    spacing (optional)
    """
    return build(
        "Divider",
        children,
        {
            "spacing": spacing,
        },
    )


def modal(
    *children: Node,
    title: str,
    open: bool | None = None,
    size: Literal["sm", "md", "lg"] | None = None,
) -> Node:
    """Modal.

    title
    open (optional)
    size (optional)
    """
    return build(
        "Modal",
        children,
        {
            "title": title,
            "open": open,
            "size": size,
        },
    )


def heading(
    *children: Node,
    text: str,
    level: Literal[1, 2, 3, 4] | None = None,
) -> Node:
    """Heading.

    text
    level (optional)
    """
    return build(
        "Heading",
        children,
        {
            "text": text,
            "level": level,
        },
    )


def text(
    *children: Node,
    text: str,
    tone: Literal["neutral", "muted", "info", "success", "warning", "danger"] | None = None,
    size: Literal["sm", "md", "lg"] | None = None,
    emphasis: bool | None = None,
) -> Node:
    """Text.

    text
    tone (optional)
    size (optional)
    emphasis (optional)
    """
    return build(
        "Text",
        children,
        {
            "text": text,
            "tone": tone,
            "size": size,
            "emphasis": emphasis,
        },
    )


def badge(
    *children: Node,
    label: str,
    tone: Literal["neutral", "muted", "info", "success", "warning", "danger"] | None = None,
) -> Node:
    """Badge.

    label
    tone (optional)
    """
    return build(
        "Badge",
        children,
        {
            "label": label,
            "tone": tone,
        },
    )


def stat_tile(
    *children: Node,
    label: str,
    value: str,
    caption: str | None = None,
    tone: Literal["neutral", "muted", "info", "success", "warning", "danger"] | None = None,
    source: dict[str, Any] | None = None,
) -> Node:
    """StatTile.

    label
    value
    caption (optional)
    tone (optional)
    source (optional)
    """
    return build(
        "StatTile",
        children,
        {
            "label": label,
            "value": value,
            "caption": caption,
            "tone": tone,
            "source": source,
        },
    )


def key_value_list(
    *children: Node,
    items: list[dict[str, Any]],
    source: dict[str, Any] | None = None,
) -> Node:
    """KeyValueList.

    items
    source (optional)
    """
    return build(
        "KeyValueList",
        children,
        {
            "items": items,
            "source": source,
        },
    )


def table(
    *children: Node,
    columns: list[dict[str, Any]],
    rows: list[dict[str, Any]] | None = None,
    dataSource: dict[str, Any] | None = None,
    rowAction: dict[str, Any] | None = None,
    emptyMessage: str | None = None,
    page: int | None = None,
    pageSize: int | None = None,
    total: int | None = None,
    source: dict[str, Any] | None = None,
) -> Node:
    """Table.

    columns
    rows (optional)
    dataSource (optional)
    rowAction (optional)
    emptyMessage (optional)
    page (optional)
    pageSize (optional)
    total (optional)
    source (optional)
    """
    return build(
        "Table",
        children,
        {
            "columns": columns,
            "rows": rows,
            "dataSource": dataSource,
            "rowAction": rowAction,
            "emptyMessage": emptyMessage,
            "page": page,
            "pageSize": pageSize,
            "total": total,
            "source": source,
        },
    )


def chart(
    *children: Node,
    kind: Literal["line", "bar", "area", "donut"],
    xKey: str,
    series: list[dict[str, Any]],
    data: list[dict[str, Any]] | None = None,
    source: dict[str, Any] | None = None,
) -> Node:
    """Chart.

    kind
    xKey
    series
    data (optional)
    source (optional)
    """
    return build(
        "Chart",
        children,
        {
            "kind": kind,
            "xKey": xKey,
            "series": series,
            "data": data,
            "source": source,
        },
    )


def alert(
    *children: Node,
    level: Literal["info", "success", "warning", "error"],
    message: str,
    title: str | None = None,
) -> Node:
    """Alert.

    level
    message
    title (optional)
    """
    return build(
        "Alert",
        children,
        {
            "level": level,
            "message": message,
            "title": title,
        },
    )


def empty_state(
    *children: Node,
    title: str,
    message: str | None = None,
    action: dict[str, Any] | None = None,
    actionLabel: str | None = None,
) -> Node:
    """EmptyState.

    title
    message (optional)
    action (optional)
    actionLabel (optional)
    """
    return build(
        "EmptyState",
        children,
        {
            "title": title,
            "message": message,
            "action": action,
            "actionLabel": actionLabel,
        },
    )


def timeline(
    *children: Node,
    items: list[dict[str, Any]],
) -> Node:
    """Timeline.

    items
    """
    return build(
        "Timeline",
        children,
        {
            "items": items,
        },
    )


def form(
    *children: Node,
    actionId: str,
    submitLabel: str | None = None,
    confirm: dict[str, Any] | None = None,
) -> Node:
    """Form.

    actionId
    submitLabel (optional)
    confirm (optional)
    """
    return build(
        "Form",
        children,
        {
            "actionId": actionId,
            "submitLabel": submitLabel,
            "confirm": confirm,
        },
    )


def text_field(
    *children: Node,
    name: str,
    label: str,
    required: bool | None = None,
    help: str | None = None,
    disabled: bool | None = None,
    visibleWhen: dict[str, Any] | None = None,
    value: str | None = None,
    placeholder: str | None = None,
) -> Node:
    """TextField.

    name
    label
    required (optional)
    help (optional)
    disabled (optional)
    visibleWhen (optional)
    value (optional)
    placeholder (optional)
    """
    return build(
        "TextField",
        children,
        {
            "name": name,
            "label": label,
            "required": required,
            "help": help,
            "disabled": disabled,
            "visibleWhen": visibleWhen,
            "value": value,
            "placeholder": placeholder,
        },
    )


def text_area(
    *children: Node,
    name: str,
    label: str,
    required: bool | None = None,
    help: str | None = None,
    disabled: bool | None = None,
    visibleWhen: dict[str, Any] | None = None,
    value: str | None = None,
    rows: int | None = None,
) -> Node:
    """TextArea.

    name
    label
    required (optional)
    help (optional)
    disabled (optional)
    visibleWhen (optional)
    value (optional)
    rows (optional)
    """
    return build(
        "TextArea",
        children,
        {
            "name": name,
            "label": label,
            "required": required,
            "help": help,
            "disabled": disabled,
            "visibleWhen": visibleWhen,
            "value": value,
            "rows": rows,
        },
    )


def number_field(
    *children: Node,
    name: str,
    label: str,
    required: bool | None = None,
    help: str | None = None,
    disabled: bool | None = None,
    visibleWhen: dict[str, Any] | None = None,
    value: float | int | None = None,
    min: float | int | None = None,
    max: float | int | None = None,
    step: float | int | None = None,
) -> Node:
    """NumberField.

    name
    label
    required (optional)
    help (optional)
    disabled (optional)
    visibleWhen (optional)
    value (optional)
    min (optional)
    max (optional)
    step (optional)
    """
    return build(
        "NumberField",
        children,
        {
            "name": name,
            "label": label,
            "required": required,
            "help": help,
            "disabled": disabled,
            "visibleWhen": visibleWhen,
            "value": value,
            "min": min,
            "max": max,
            "step": step,
        },
    )


def select(
    *children: Node,
    name: str,
    label: str,
    options: list[dict[str, Any]],
    required: bool | None = None,
    help: str | None = None,
    disabled: bool | None = None,
    visibleWhen: dict[str, Any] | None = None,
    value: str | None = None,
) -> Node:
    """Select.

    name
    label
    options
    required (optional)
    help (optional)
    disabled (optional)
    visibleWhen (optional)
    value (optional)
    """
    return build(
        "Select",
        children,
        {
            "name": name,
            "label": label,
            "options": options,
            "required": required,
            "help": help,
            "disabled": disabled,
            "visibleWhen": visibleWhen,
            "value": value,
        },
    )


def multi_select(
    *children: Node,
    name: str,
    label: str,
    options: list[dict[str, Any]],
    required: bool | None = None,
    help: str | None = None,
    disabled: bool | None = None,
    visibleWhen: dict[str, Any] | None = None,
    value: list[str] | None = None,
) -> Node:
    """MultiSelect.

    name
    label
    options
    required (optional)
    help (optional)
    disabled (optional)
    visibleWhen (optional)
    value (optional)
    """
    return build(
        "MultiSelect",
        children,
        {
            "name": name,
            "label": label,
            "options": options,
            "required": required,
            "help": help,
            "disabled": disabled,
            "visibleWhen": visibleWhen,
            "value": value,
        },
    )


def date_field(
    *children: Node,
    name: str,
    label: str,
    required: bool | None = None,
    help: str | None = None,
    disabled: bool | None = None,
    visibleWhen: dict[str, Any] | None = None,
    value: str | None = None,
) -> Node:
    """DateField.

    name
    label
    required (optional)
    help (optional)
    disabled (optional)
    visibleWhen (optional)
    value (optional)
    """
    return build(
        "DateField",
        children,
        {
            "name": name,
            "label": label,
            "required": required,
            "help": help,
            "disabled": disabled,
            "visibleWhen": visibleWhen,
            "value": value,
        },
    )


def date_range(
    *children: Node,
    name: str,
    label: str,
    required: bool | None = None,
    help: str | None = None,
    disabled: bool | None = None,
    visibleWhen: dict[str, Any] | None = None,
    from_: str | None = None,
    to: str | None = None,
) -> Node:
    """DateRange.

    name
    label
    required (optional)
    help (optional)
    disabled (optional)
    visibleWhen (optional)
    from_ (optional) — sent as `from`
    to (optional)
    """
    return build(
        "DateRange",
        children,
        {
            "name": name,
            "label": label,
            "required": required,
            "help": help,
            "disabled": disabled,
            "visibleWhen": visibleWhen,
            "from": from_,
            "to": to,
        },
    )


def checkbox(
    *children: Node,
    name: str,
    label: str,
    required: bool | None = None,
    help: str | None = None,
    disabled: bool | None = None,
    visibleWhen: dict[str, Any] | None = None,
    checked: bool | None = None,
) -> Node:
    """Checkbox.

    name
    label
    required (optional)
    help (optional)
    disabled (optional)
    visibleWhen (optional)
    checked (optional)
    """
    return build(
        "Checkbox",
        children,
        {
            "name": name,
            "label": label,
            "required": required,
            "help": help,
            "disabled": disabled,
            "visibleWhen": visibleWhen,
            "checked": checked,
        },
    )


def switch(
    *children: Node,
    name: str,
    label: str,
    required: bool | None = None,
    help: str | None = None,
    disabled: bool | None = None,
    visibleWhen: dict[str, Any] | None = None,
    checked: bool | None = None,
) -> Node:
    """Switch.

    name
    label
    required (optional)
    help (optional)
    disabled (optional)
    visibleWhen (optional)
    checked (optional)
    """
    return build(
        "Switch",
        children,
        {
            "name": name,
            "label": label,
            "required": required,
            "help": help,
            "disabled": disabled,
            "visibleWhen": visibleWhen,
            "checked": checked,
        },
    )


def radio_group(
    *children: Node,
    name: str,
    label: str,
    options: list[dict[str, Any]],
    required: bool | None = None,
    help: str | None = None,
    disabled: bool | None = None,
    visibleWhen: dict[str, Any] | None = None,
    value: str | None = None,
) -> Node:
    """RadioGroup.

    name
    label
    options
    required (optional)
    help (optional)
    disabled (optional)
    visibleWhen (optional)
    value (optional)
    """
    return build(
        "RadioGroup",
        children,
        {
            "name": name,
            "label": label,
            "options": options,
            "required": required,
            "help": help,
            "disabled": disabled,
            "visibleWhen": visibleWhen,
            "value": value,
        },
    )


def file_upload(
    *children: Node,
    name: str,
    label: str,
    required: bool | None = None,
    help: str | None = None,
    disabled: bool | None = None,
    visibleWhen: dict[str, Any] | None = None,
    accept: list[str] | None = None,
    multiple: bool | None = None,
) -> Node:
    """FileUpload.

    name
    label
    required (optional)
    help (optional)
    disabled (optional)
    visibleWhen (optional)
    accept (optional)
    multiple (optional)
    """
    return build(
        "FileUpload",
        children,
        {
            "name": name,
            "label": label,
            "required": required,
            "help": help,
            "disabled": disabled,
            "visibleWhen": visibleWhen,
            "accept": accept,
            "multiple": multiple,
        },
    )


def hidden(
    *children: Node,
    name: str,
    value: str,
) -> Node:
    """Hidden.

    name
    value
    """
    return build(
        "Hidden",
        children,
        {
            "name": name,
            "value": value,
        },
    )


def button(
    *children: Node,
    label: str,
    variant: Literal["primary", "secondary", "danger", "ghost"] | None = None,
    size: Literal["sm", "md", "lg"] | None = None,
    disabled: bool | None = None,
    action: dict[str, Any] | None = None,
    confirm: dict[str, Any] | None = None,
) -> Node:
    """Button.

    label
    variant (optional)
    size (optional)
    disabled (optional)
    action (optional)
    confirm (optional)
    """
    return build(
        "Button",
        children,
        {
            "label": label,
            "variant": variant,
            "size": size,
            "disabled": disabled,
            "action": action,
            "confirm": confirm,
        },
    )


def link(
    *children: Node,
    label: str,
    screenId: str | None = None,
    satelliteId: str | None = None,
    params: dict[str, Any] | None = None,
    href: str | None = None,
) -> Node:
    """Link.

    label
    screenId (optional)
    satelliteId (optional)
    params (optional)
    href (optional)
    """
    return build(
        "Link",
        children,
        {
            "label": label,
            "screenId": screenId,
            "satelliteId": satelliteId,
            "params": params,
            "href": href,
        },
    )


def menu_button(
    *children: Node,
    label: str,
    items: list[dict[str, Any]],
) -> Node:
    """MenuButton.

    label
    items
    """
    return build(
        "MenuButton",
        children,
        {
            "label": label,
            "items": items,
        },
    )
