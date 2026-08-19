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

    def test_refuses_a_component_that_cannot_carry_one(self) -> None:
        # Every component schema is strict and only four declare `source`, so
        # citing a Text produces a node the hub refuses. Raising here names the
        # mistake where it was made instead of at request time.
        with pytest.raises(ValueError, match="cannot carry a source"):
            with_source("call-1", ui.text(text="hello"))

    def test_the_citable_set_is_exactly_what_declares_source(self) -> None:
        import inspect

        from portal_sdk import ui as module
        from portal_sdk.protocol import CITABLE

        declared = {
            name
            for name in module.__all__
            if "source" in inspect.signature(getattr(module, name)).parameters
        }
        # Compares generated-to-generated, so it catches a builder gaining or
        # losing `source` without the citable set following.
        assert {n.lower().replace("_", "") for n in CITABLE} == {
            n.replace("_", "") for n in declared
        }

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

    def test_a_failure_toast_uses_the_level_the_protocol_defines(self) -> None:
        # `ToastSchema` is `success | info | warning | error`. "danger" is a
        # component *tone*, and this shipped with it — an envelope the hub
        # rejects outright, from the SDK's own helper.
        assert env.failed("Nope")["toast"]["level"] == "error"
        assert "danger" not in env.ToastLevel.__args__

    def test_a_validation_outcome_with_no_field_errors_is_refused_here(self) -> None:
        # The hub rejects it; refusing at the call site names the line that
        # built it instead of a response nobody can see.
        with pytest.raises(ValueError):
            env.invalid({})

    def test_a_nav_entry_may_omit_section_and_order(self) -> None:
        # Both are optional in the manifest schema. A satellite with one entry
        # has nothing to group it with and nothing to order it against.
        assert env.nav_entry("fleet.dashboard", "Fleet") == {
            "screenId": "fleet.dashboard",
            "label": "Fleet",
        }

    def test_an_action_that_only_says_done_says_only_that(self) -> None:
        assert env.ok() == {"protocol": env.PROTOCOL, "outcome": "ok"}

    def test_a_manifest_states_its_audience(self) -> None:
        # No default. A satellite that forgot would otherwise inherit one, and
        # the whole audience model is default-deny.
        with pytest.raises(TypeError):
            env.manifest(  # type: ignore[call-arg]
                satellite_id="fleet", display_name="Fleet", screens=[]
            )


class TestGuards:
    """Envelopes the protocol refuses, refused where they are written."""

    def test_an_empty_audience_is_not_default_deny(self) -> None:
        # `AudienceListSchema` is `.nonempty()`, so an empty list makes the hub
        # reject the whole manifest — taking every screen and action with it.
        with pytest.raises(ValueError, match="must not be empty"):
            env.manifest(
                satellite_id="depots", display_name="Depots", audience=[], screens=[]
            )
        with pytest.raises(ValueError, match="must not be empty"):
            env.screen_descriptor("depots.dashboard", "Depots", audience=[])

    def test_a_toast_needs_something_to_say(self) -> None:
        # `ToastSchema.message` is `.min(1)`.
        with pytest.raises(ValueError, match="needs a message"):
            env.failed("")
        with pytest.raises(ValueError, match="needs a message"):
            env.ok(message="   ")

    def test_a_level_without_a_message_shows_nothing(self) -> None:
        # `level` is only read when there is a message, so this asks for a
        # report and silently gets none.
        with pytest.raises(ValueError, match="no effect without a message"):
            env.ok(level="error")
        # The default with no message stays legal.
        assert "toast" not in env.ok()

    def test_an_empty_choice_list_is_not_a_choice(self) -> None:
        with pytest.raises(ValueError, match="must not be empty"):
            env.action_param("reason", "string", choices=[])

    def test_choices_belong_only_to_a_string_parameter(self) -> None:
        # `ActionParamSchema` refuses this: the choices are strings, so on a
        # number they describe a parameter no value can satisfy.
        with pytest.raises(ValueError, match="only meaningful on a string"):
            env.action_param("quantity", "number", choices=["1", "2"])
        with pytest.raises(ValueError, match="only meaningful on a string"):
            env.action_param("force", "boolean", choices=["yes"])

    def test_choices_constrain_the_entries_of_a_list(self) -> None:
        # `string[]` is the other type choices are meaningful on: they describe
        # each entry, not the list. Refusing them here would have left a Python
        # satellite unable to declare a `MultiSelect` its own form renders.
        assert env.action_param("tags", "string[]", choices=["retail"]) == {
            "name": "tags",
            "type": "string[]",
            "required": False,
            "enum": ["retail"],
        }

    def test_an_action_declares_an_audience_too(self) -> None:
        # The manifest-wide guard is worth nothing if a descriptor can slip an
        # empty list past it — the hub rejects the whole manifest either way.
        with pytest.raises(ValueError, match="must not be empty"):
            env.action_descriptor("depots.close", audience=[])


class TestActionDeclarations:
    def test_an_action_parameter_states_its_type(self) -> None:
        # The MCP gateway turns these into a tool's input schema; a parameter
        # with no type is one a model cannot fill in.
        assert env.action_param("id", "string", required=True) == {
            "name": "id",
            "type": "string",
            "required": True,
        }

    def test_choices_reach_the_wire_as_enum(self) -> None:
        entry = env.action_param("reason", "string", choices=["maintenance"])
        assert entry["enum"] == ["maintenance"]

    def test_an_action_descriptor_carries_its_params(self) -> None:
        descriptor = env.action_descriptor(
            "depots.close",
            audience=["internal"],
            title="Close depot",
            params=[env.action_param("id", "string", required=True)],
        )
        assert descriptor["id"] == "depots.close"
        assert descriptor["params"][0]["name"] == "id"

    def test_navigate_can_leave_the_current_satellite(self) -> None:
        # Without satelliteId the hub resolves against the current satellite,
        # which cannot express "now go to the order this shipment belongs to".
        assert env.navigate("orders.detail", {"id": "1"}, satellite_id="orders") == {
            "screenId": "orders.detail",
            "satelliteId": "orders",
            "params": {"id": "1"},
        }
        assert "satelliteId" not in env.navigate("depots.detail")


class TestVisibleWhen:
    def test_builds_an_equals_rule(self) -> None:
        from portal_sdk import visible_when

        assert visible_when("expedited", equals=True) == {"field": "expedited", "equals": True}

    def test_builds_a_membership_rule(self) -> None:
        from portal_sdk import visible_when

        assert visible_when("tags", one_of=["hazmat"]) == {"field": "tags", "oneOf": ["hazmat"]}

    def test_refuses_both_or_neither(self) -> None:
        from portal_sdk import visible_when

        with pytest.raises(ValueError):
            visible_when("tags")
        with pytest.raises(ValueError):
            visible_when("tags", equals="a", one_of=["a"])

    def test_refuses_an_empty_membership_list(self) -> None:
        from portal_sdk import visible_when

        # Matches nothing, so the field never appears — a bug wearing the
        # costume of a configuration.
        with pytest.raises(ValueError):
            visible_when("tags", one_of=[])

    def test_reaches_a_builder_as_the_catalog_spells_it(self) -> None:
        from portal_sdk import ui, visible_when

        node = ui.text_field(
            name="expediteReason",
            label="Why?",
            visibleWhen=visible_when("expedited", equals=True),
        )
        assert node["props"]["visibleWhen"] == {"field": "expedited", "equals": True}
