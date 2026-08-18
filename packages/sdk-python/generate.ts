import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CATALOG_VERSION, COMPONENTS, COMPONENT_NAMES } from "@portal/catalog";
import {
  ActionResponseSchema,
  AudienceSchema,
  CURRENT_PROTOCOL_VERSION,
  ToastSchema,
} from "@portal/protocol";

/**
 * The Python SDK is generated from the catalog, not written beside it.
 *
 * A second SDK is a second place the vocabulary lives, and a second place it
 * can drift. That is the failure this whole architecture is built to avoid —
 * declarations that rot because nothing shipping depends on them — so
 * reintroducing it in the tooling would be a poor joke. The catalog stays the
 * one definition of what a component is; every language surface is a
 * projection, exactly like the screens, the agent tools and the public API.
 *
 * `pnpm sdk:python` regenerates. CI runs it and fails if the checked-in file
 * differs, which is what makes "cannot drift" a fact rather than an intention.
 */

interface JsonSchemaNode {
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchemaNode;
  readonly anyOf?: readonly JsonSchemaNode[];
  readonly const?: unknown;
}

/** `StatTile` → `stat_tile`. Python reads snake_case; the wire stays PascalCase. */
function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Python keywords, plus the builtins worth shadowing carefully.
 *
 * This matters for *props*, not only component names: the catalog has a
 * `DateRange.from`, and `from` cannot be a parameter name in Python at all —
 * the module fails to parse, which is how this was found. A trailing
 * underscore is the convention, and the wire name is unaffected because the
 * builder writes the original string into the payload.
 */
const RESERVED = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
  "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
  "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while",
  "with", "yield", "None", "True", "False", "match", "case", "type",
  "id", "input", "list", "dict", "set", "print", "filter", "format", "next", "object",
]);

/** For a component name: `StatTile` → `stat_tile`. */
function safeName(name: string): string {
  return pyName(snake(name));
}

/** For a parameter: `from` → `from_`, everything else untouched. */
function pyName(name: string): string {
  return RESERVED.has(name) ? `${name}_` : name;
}

/**
 * A prop's Python type annotation.
 *
 * Deliberately conservative: anything this cannot express precisely becomes
 * `Any` rather than a guess. A wrong annotation is worse than a loose one,
 * because a type checker will confidently reject correct code.
 */
function annotate(schema: JsonSchemaNode): string {
  if (schema.enum !== undefined) {
    const literals = schema.enum
      .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
      .map((value) => (typeof value === "string" ? JSON.stringify(value) : String(value)));
    return literals.length === schema.enum.length && literals.length > 0
      ? `Literal[${literals.join(", ")}]`
      : "Any";
  }

  if (schema.anyOf !== undefined) {
    // A union of consts is an enum spelled the long way, which is how
    // `z.union([z.literal(1), …])` arrives.
    const consts = schema.anyOf.map((member) => member.const).filter((value) => value !== undefined);
    if (consts.length === schema.anyOf.length && consts.length > 0) {
      return `Literal[${consts.map((value) => (typeof value === "string" ? JSON.stringify(value) : String(value))).join(", ")}]`;
    }
    return "Any";
  }

  switch (schema.type) {
    case "string":
      return "str";
    case "boolean":
      return "bool";
    case "integer":
      return "int";
    case "number":
      return "float | int";
    case "array":
      return schema.items === undefined ? "list[Any]" : `list[${annotate(schema.items)}]`;
    case "object":
      return "dict[str, Any]";
    default:
      return "Any";
  }
}

const header = `"""Typed builders for Portal UI screens.

GENERATED FROM THE CATALOG — DO NOT EDIT.

Run \`pnpm sdk:python\` to regenerate. CI regenerates and fails if this file
differs, so it cannot drift from the vocabulary the hub actually validates.

Catalog version ${CATALOG_VERSION}, ${COMPONENT_NAMES.length} components.

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

A misspelled prop is a \`TypeError\` where you wrote it, naming the component —
not a rejected response from the hub at request time, in an environment you
cannot see. A wrong enum value is flagged by your type checker before it runs.
"""

from __future__ import annotations

from typing import Any, Literal

from .node import Node, build

__all__ = [
${COMPONENT_NAMES.map((name) => `    ${JSON.stringify(safeName(name))},`).join("\n")}
]

`;

function emit(name: string): string {
  const converted = zodToJsonSchema(COMPONENTS[name as keyof typeof COMPONENTS], {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as JsonSchemaNode;

  const properties = converted.properties ?? {};
  const required = new Set(converted.required ?? []);
  const names = Object.keys(properties);

  // Required first, so the signature reads the way the component does.
  const ordered = [...names].sort((a, b) => Number(required.has(b)) - Number(required.has(a)));

  const params = ordered.map((prop) => {
    const annotation = annotate(properties[prop] as JsonSchemaNode);
    return required.has(prop)
      ? `    ${pyName(prop)}: ${annotation},`
      : `    ${pyName(prop)}: ${annotation} | None = None,`;
  });

  // Key by the wire name, value from the Python-safe parameter. The two differ
  // only where a prop collides with a keyword, and the payload never sees it.
  const collected = ordered
    .map((prop) => `            ${JSON.stringify(prop)}: ${pyName(prop)},`)
    .join("\n");

  const signature =
    params.length === 0
      ? `def ${safeName(name)}(*children: Node) -> Node:`
      : [`def ${safeName(name)}(`, "    *children: Node,", ...params, ") -> Node:"].join("\n");

  const docProps =
    ordered.length === 0
      ? "    Takes no props."
      : ordered
          .map((prop) => {
            const renamed = pyName(prop) === prop ? "" : ` — sent as \`${prop}\``;
            return `    ${pyName(prop)}${required.has(prop) ? "" : " (optional)"}${renamed}`;
          })
          .join("\n");

  return `${signature}
    """${name}.

${docProps}
    """
    return build(
        ${JSON.stringify(name)},
        children,
        {
${collected}
        },
    )
`;
}

/**
 * The protocol's vocabulary, emitted rather than retyped.
 *
 * A review found `failed()` sending `{"level": "danger"}` — a component *tone*,
 * not a toast level, which the hub rejects outright. It was hand-copied from
 * the TypeScript and got one word wrong, and no satellite here ships an action,
 * so nothing caught it. Three languages means three chances to make that
 * mistake; the fix is to stop making the copy by hand.
 */
function literals(schema: unknown, path?: string): readonly string[] {
  const json = zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0], {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as JsonSchemaNode;
  const node = path === undefined ? json : (json.properties?.[path] as JsonSchemaNode | undefined);
  const values = node?.enum;
  if (values === undefined || values.length === 0) {
    throw new Error(`no enum found for ${path ?? "the schema"} — the protocol shape changed`);
  }
  return values.map(String);
}

function pyLiteral(values: readonly string[]): string {
  return `Literal[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

const protocolModule = `"""The protocol's constants, as the hub defines them.

GENERATED FROM @portal/protocol — DO NOT EDIT.

Run \`pnpm sdk:python\` to regenerate; \`pnpm sdk:check\` fails if this is stale.

Everything here was previously retyped into Python by hand, which is how a
toast went out carrying a component tone the hub refuses. A vocabulary copied
by hand is a vocabulary that drifts.
"""

from __future__ import annotations

from typing import Literal

#: The version this SDK emits.
PROTOCOL = ${JSON.stringify(CURRENT_PROTOCOL_VERSION)}

#: Toast levels. Note \`error\`, not \`danger\` — \`danger\` is a component tone.
ToastLevel = ${pyLiteral(literals(ToastSchema, "level"))}

#: What an action reports back.
ActionOutcome = ${pyLiteral(literals(ActionResponseSchema, "outcome"))}

#: Who a satellite, screen or action is visible to. Default-deny: absent means
#: internal, and external must always be stated.
Audience = ${pyLiteral(literals(AudienceSchema))}

#: The components whose schema declares \`source\`. Only these can carry a
#: citation: every component schema is strict, so a citation on anything else
#: is a node the hub refuses rather than one it merely ignores.
CITABLE = frozenset(
    {
${COMPONENT_NAMES.filter((name) => "source" in COMPONENTS[name].shape)
  .map((name) => `        ${JSON.stringify(name)},`)
  .join("\n")}
    }
)
`;

const body = COMPONENT_NAMES.map(emit).join("\n\n");
const root = join(dirname(fileURLToPath(import.meta.url)), "portal_sdk");
const target = join(root, "ui.py");
const protocolTarget = join(root, "protocol.py");
const generated = `${header}\n${body}`;

/**
 * `--check` compares instead of writing, which is the only order that works.
 *
 * The first version of this check regenerated the file and then asked git
 * whether it had changed. It cannot ever fail: regenerating *fixes* the file
 * first, so the diff is always empty — and it sees nothing at all for a file
 * git is not yet tracking. A guard that passes because it destroyed the
 * evidence is worse than none, because it reads as coverage.
 */
const outputs: readonly (readonly [string, string])[] = [
  [target, generated],
  [protocolTarget, protocolModule],
];

if (process.argv.includes("--check")) {
  for (const [path, expected] of outputs) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current !== expected) {
      process.stderr.write(
        current === ""
          ? `${path} does not exist. Run \`pnpm sdk:python\`.\n`
          : `${path} is out of date. Run \`pnpm sdk:python\` and commit the result.\n`,
      );
      process.exit(1);
    }
  }
  process.stdout.write(`up to date — ${COMPONENT_NAMES.length} components\n`);
} else {
  for (const [path, contents] of outputs) writeFileSync(path, contents, "utf8");
  process.stdout.write(`wrote ${outputs.length} files — ${COMPONENT_NAMES.length} components\n`);
}
