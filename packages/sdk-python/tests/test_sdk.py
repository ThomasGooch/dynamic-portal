"""What the SDK must not get wrong.

These test the hand-written runtime and the *shape* of what the generator
emits — not the vocabulary itself, which is the catalog's to define and the
drift check's to police.
"""

from __future__ import annotations

import keyword

import pytest
from portal_sdk import envelopes as env
from portal_sdk import ui, with_id, with_source


class TestBuilding:
    def test_omits_props_that_were_never_set(self) -> None:
        # Absent, not null. The catalog marks optional props optional rather
        # than nullable, so an explicit null is a response the hub rejects.
        node = ui.stat_tile(label="Pending", value="2")
        assert node == {"type": "StatTile", "props": {"label": "Pending", "value": "2"}}
        assert "caption" not in node["props"]

    def test_carries_children_positionally(self) -> None:
        node = ui.grid(ui.badge(label="A"), ui.badge(label="B"), columns=2)
        assert node["props"] == {"columns": 2}
        assert [child["type"] for child in node["children"]] == ["Badge", "Badge"]

    def test_a_node_with_no_children_has_no_children_key(self) -> None:
        assert "children" not in ui.badge(label="A")

    def test_rejects_a_misspelled_prop_where_it_was_written(self) -> None:
        # The whole point. A dict literal would carry `labell` all the way to
        # the hub and fail there, in a process the satellite cannot see.
        with pytest.raises(TypeError):
            ui.badge(labell="A")  # type: ignore[call-arg]

    def test_requires_the_props_the_catalog_requires(self) -> None:
        with pytest.raises(TypeError):
            ui.stat_tile(label="Pending")  # type: ignore[call-arg]


class TestKeywordProps:
    def test_a_prop_named_for_a_python_keyword_is_still_reachable(self) -> None:
        # `DateRange.from` cannot be a parameter name in Python — the module
        # will not even parse. The generator renames the parameter and keeps
        # the wire name, which is the only combination that works.
        node = ui.date_range(name="window", label="Window", from_="2026-01-01", to="2026-03-31")
        assert node["props"]["from"] == "2026-01-01"
        assert "from_" not in node["props"]

    def test_no_generated_parameter_is_a_python_keyword(self) -> None:
        import inspect

        from portal_sdk import ui as module

        for name in module.__all__:
            builder = getattr(module, name)
            for param in inspect.signature(builder).parameters:
                assert not keyword.iskeyword(param), f"{name}({param}=…) will not parse"


class TestProvenance:
    def test_source_is_a_prop_because_that_is_where_grounding_looks(self) -> None:
        # Grounding reads `props.source`, and so does every provenance mark the
        # renderer draws. The node's top-level `source` field is read by
        # nothing; writing there produces a citation nobody can see.
        node = with_source("call-1", ui.stat_tile(label="Pending", value="2"))
        assert node["props"]["source"] == {"toolCallId": "call-1"}
        assert "source" not in {k: v for k, v in node.items() if k != "props"}

    def test_keeps_the_props_it_already_had(self) -> None:
        node = with_source("call-1", ui.stat_tile(label="Pending", value="2", tone="warning"))
        assert node["props"]["tone"] == "warning"
        assert node["props"]["label"] == "Pending"

    def test_id_is_not_a_prop_because_it_belongs_to_the_node(self) -> None:
        node = with_id("fleet-table", ui.table(columns=[{"key": "id", "label": "Id"}]))
        assert node["id"] == "fleet-table"
        assert "id" not in node["props"]


class TestEnvelopes:
    def test_a_screen_carries_the_protocol_version(self) -> None:
        body = env.screen("fleet.dashboard", "Fleet", ui.page())
        assert body["protocol"] == env.PROTOCOL
        assert body["screen"] == {"id": "fleet.dashboard", "title": "Fleet"}

    def test_meta_is_absent_rather_than_empty(self) -> None:
        assert "meta" not in env.screen("s", "S", ui.page())
        assert env.screen("s", "S", ui.page(), ttl_seconds=30)["meta"] == {"ttlSeconds": 30}

    def test_the_last_breadcrumb_does_not_link(self) -> None:
        assert env.crumb("Fleet", "fleet.dashboard") == {
            "label": "Fleet",
            "screenId": "fleet.dashboard",
        }
        assert env.crumb("AB-12 CDE") == {"label": "AB-12 CDE"}

    def test_validation_and_failure_are_different_outcomes(self) -> None:
        # One is the user's to fix and renders against the field; the other is
        # the system's. Collapsing them tells a user to correct something they
        # did not get wrong.
        assert env.invalid({"depot": "Unknown depot"})["outcome"] == "validation"
        assert env.failed("The depot service is unavailable.")["outcome"] == "error"

    def test_an_action_that_only_says_done_says_only_that(self) -> None:
        assert env.ok() == {"protocol": env.PROTOCOL, "outcome": "ok"}

    def test_a_manifest_states_its_audience(self) -> None:
        # No default. A satellite that forgot would otherwise inherit one, and
        # the whole audience model is default-deny.
        with pytest.raises(TypeError):
            env.manifest(  # type: ignore[call-arg]
                satellite_id="fleet", display_name="Fleet", screens=[]
            )
