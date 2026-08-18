import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CATALOG_VERSION, COMPONENTS, COMPONENT_NAMES } from "@portal/catalog";
import {
  ActionParamSchema,
  ActionResponseSchema,
  AudienceSchema,
  CURRENT_PROTOCOL_VERSION,
  ToastSchema,
} from "@portal/protocol";

/**
 * The C# SDK, generated from the same catalog as the other two.
 *
 * Third language, same rule: the catalog is the one definition of what a
 * component is, and every language surface is a projection of it. A hand-
 * written third SDK would be a third place the vocabulary can drift — and the
 * Python one already proved that is not hypothetical, by shipping a toast
 * level retyped one word wrong.
 *
 * What differs from Python is what the language can enforce. C# has real
 * enums, so a wrong `tone` does not compile rather than failing at the hub;
 * that is most of the reason to ship an SDK for a typed language at all.
 */

interface JsonSchemaNode {
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchemaNode;
  readonly additionalProperties?: JsonSchemaNode | boolean;
  readonly anyOf?: readonly JsonSchemaNode[];
  readonly const?: unknown;
}

const jsonSchema = (schema: unknown): JsonSchemaNode =>
  zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0], {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as JsonSchemaNode;

/**
 * `stat-tile`/`from` → `StatTile`/`From`. C# members are PascalCase.
 *
 * `[]` is spelled out rather than stripped. Dropping it turned the protocol's
 * `string[]` into `String`, which collided with the existing `String` member
 * and generated an enum whose `ToWire` mapped every plain string parameter to
 * `"string[]"` — a silent type change on every action in the portal. It
 * compiled, because a duplicate enum member is only an error in C# when both
 * names are identical *and* the file is read, and nothing read it.
 *
 * The rule is deliberately loud: a protocol value this cannot name distinctly
 * should fail here rather than emit something plausible.
 */
function pascal(name: string): string {
  const parts = name
    .replace(/\[\]$/, " list")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));

  if (parts.length === 0) {
    throw new Error(`cannot name the protocol value ${JSON.stringify(name)} in C#`);
  }
  return parts.join("");
}

/** C# keywords that cannot be parameter names without an `@` prefix. */
const KEYWORDS = new Set([
  "abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char", "checked",
  "class", "const", "continue", "decimal", "default", "delegate", "do", "double", "else",
  "enum", "event", "explicit", "extern", "false", "finally", "fixed", "float", "for",
  "foreach", "goto", "if", "implicit", "in", "int", "interface", "internal", "is", "lock",
  "long", "namespace", "new", "null", "object", "operator", "out", "override", "params",
  "private", "protected", "public", "readonly", "ref", "return", "sbyte", "sealed", "short",
  "sizeof", "stackalloc", "static", "string", "struct", "switch", "this", "throw", "true",
  "try", "typeof", "uint", "ulong", "unchecked", "unsafe", "ushort", "using", "virtual",
  "void", "volatile", "while",
]);

/**
 * A parameter name C# will accept.
 *
 * `@` rather than a rename: C#'s verbatim identifier keeps the name intact at
 * the call site, so a prop called `from` is written `from:` with an `@` only in
 * the declaration. Python had to rename it to `from_`; C# does not.
 */
const paramName = (prop: string): string => {
  const camel = prop.charAt(0).toLowerCase() + prop.slice(1);
  return KEYWORDS.has(camel) ? `@${camel}` : camel;
};

/**
 * Shared enums, recognised by their exact value set.
 *
 * `zodToJsonSchema` inlines `Tone`, `Size`, `Align` and `Gap` at every use, so
 * the names are gone by the time this sees them. Matching on the values
 * recovers them, and anything unrecognised is named for where it appears —
 * deterministic either way, which is what the drift check requires.
 */
/**
 * Joins a value set into a comparable key.
 *
 * A literal NUL byte would make git classify this generator as binary and stop
 * diffing it, so the escape is written rather than typed. No catalog value
 * contains one, which is the only property the separator needs.
 */
const SEPARATOR = "\u0000";

const SHARED: readonly { readonly name: string; readonly values: readonly string[] }[] = [
  { name: "Tone", values: ["neutral", "muted", "info", "success", "warning", "danger"] },
  { name: "Size", values: ["sm", "md", "lg"] },
  { name: "Align", values: ["start", "center", "end"] },
  { name: "Gap", values: ["none", "xs", "sm", "md", "lg"] },
];

/**
 * A generated enum: the catalog's values, the C# members that stand for them,
 * and what `ToWire` hands back.
 *
 * Members are carried rather than derived at emission time because a numeric
 * enum cannot name itself — `1` is not an identifier — so it borrows the prop's
 * name and that is only known here.
 */
interface EnumSpec {
  readonly values: readonly (string | number)[];
  readonly members: readonly string[];
  /** The wire form: catalog strings stay strings, numeric literals stay numbers. */
  readonly wire: "string" | "int";
}

const enums = new Map<string, EnumSpec>();

const keyOf = (values: readonly (string | number)[]): string =>
  values.map(String).join(SEPARATOR);

function enumName(
  component: string,
  prop: string,
  values: readonly (string | number)[],
): string {
  const key = keyOf(values);
  const shared = SHARED.find((candidate) => keyOf(candidate.values) === key);
  const name = shared?.name ?? `${component}${pascal(prop)}`;

  const existing = enums.get(name);
  if (existing !== undefined && keyOf(existing.values) !== key) {
    // Two different value sets wanting one name would silently generate the
    // wrong type for one of them.
    throw new Error(`enum name ${name} is claimed by two different value sets`);
  }

  const numeric = typeof values[0] === "number";
  enums.set(name, {
    values,
    // `pascal(2)` is `"2"`, which is not an identifier, so a numeric member is
    // prefixed with the prop it belongs to: `HeadingLevel.Level2`.
    members: values.map((value) =>
      numeric ? `${pascal(prop)}${value}` : pascal(String(value)),
    ),
    wire: numeric ? "int" : "string",
  });
  return name;
}

/**
 * The values a prop is restricted to, when C# can express the restriction.
 *
 * Both spellings `zodToJsonSchema` produces are read. A `z.enum([...])` becomes
 * `{ type, enum }`; a union of literals becomes the same, but an older or
 * differently-configured emitter produces `anyOf` of `const`s instead. Reading
 * only the first is how `Heading.level` — the catalog's `1 | 2 | 3 | 4` —
 * reached C# as an unconstrained `double`, where `level: 2.5` compiled and the
 * hub rejected it.
 */
function enumValues(schema: JsonSchemaNode): readonly (string | number)[] | undefined {
  const listed =
    schema.enum ??
    (schema.anyOf !== undefined &&
    schema.anyOf.every((member) => member.const !== undefined)
      ? schema.anyOf.map((member) => member.const)
      : undefined);

  if (listed === undefined || listed.length === 0) return undefined;
  if (listed.every((value) => typeof value === "string")) return listed as readonly string[];
  if (listed.every((value) => typeof value === "number" && Number.isInteger(value))) {
    return listed as readonly number[];
  }
  // A mixed or non-integer set has no faithful C# enum; fall through to the
  // plain type rather than generate something that lies about what is legal.
  return undefined;
}

/**
 * Refuses a container whose elements are a generated enum.
 *
 * `ToWire()` is applied by looking the *prop's own* type up in `enums`, and
 * neither a list nor a record is in there — so a `z.array(Tone)` would compile
 * and then put `[3]` on the wire instead of `["success"]`. The catalog has no
 * such prop today and is additive-only, so this refuses loudly rather than
 * waiting to be discovered as a rejected envelope.
 *
 * Both containers, not just lists: a `z.record(z.string(), Tone)` reaches the
 * wire the same way and by the same route.
 */
function refuseEnumElements(
  component: string,
  prop: string,
  element: string,
  container: "list" | "record",
): void {
  if (!enums.has(element)) return;
  throw new Error(
    `${component}.${prop} is a ${container} of ${element}; the emitter cannot convert ` +
      "enum elements to their wire strings. Teach `assignments` to map the " +
      "element before adding this prop to the catalog.",
  );
}

/** A prop's C# type. Anything not expressible precisely becomes `object`. */
function annotate(component: string, prop: string, schema: JsonSchemaNode): string {
  const values = enumValues(schema);
  if (values !== undefined) return enumName(component, prop, values);

  if (schema.anyOf !== undefined) return "object";

  switch (schema.type) {
    case "string":
      return "string";
    case "boolean":
      return "bool";
    case "integer":
      return "int";
    case "number":
      return "double";
    case "array": {
      if (schema.items === undefined) return "IReadOnlyList<object>";
      const element = annotate(component, prop, schema.items);
      refuseEnumElements(component, prop, element, "list");
      return `IReadOnlyList<${element}>`;
    }
    case "object": {
      // A record — `properties` absent, `additionalProperties` describing the
      // values — carries its value type into C#. Without this a `Link`'s
      // `params` accepts an `int`, which the hub then rejects for not being
      // the string the catalog asked for.
      const values = schema.additionalProperties;
      const valueType =
        schema.properties === undefined && typeof values === "object" && values.type !== undefined
          ? annotate(component, prop, values)
          : "object?";
      refuseEnumElements(component, prop, valueType, "record");
      return `IReadOnlyDictionary<string, ${valueType}>`;
    }
    default:
      return "object";
  }
}

function emit(name: string): { readonly code: string; readonly citable: boolean } {
  const converted = jsonSchema(COMPONENTS[name as keyof typeof COMPONENTS]);
  const properties = converted.properties ?? {};
  const required = new Set(converted.required ?? []);
  const ordered = Object.keys(properties).sort(
    (a, b) => Number(required.has(b)) - Number(required.has(a)),
  );

  // Annotated once and reused: `annotate` registers generated enums as a side
  // effect, so calling it twice per prop asks the emitter to re-derive — and
  // re-register — every enum in the catalog for no gain.
  const typed = ordered.map((prop) => ({
    prop,
    type: annotate(name, prop, properties[prop] as JsonSchemaNode),
  }));

  // `?` on every optional prop: value types and enums need it to be nullable at
  // all, and reference types need it for the compiler to police the difference.
  const params = typed.map(({ prop, type }) =>
    required.has(prop)
      ? `${type} ${paramName(prop)}`
      : `${type}? ${paramName(prop)} = null`,
  );

  const assignments = typed.map(({ prop, type }) => {
    const value = enums.has(type)
      ? required.has(prop)
        ? `${paramName(prop)}.ToWire()`
        : `${paramName(prop)}?.ToWire()`
      : paramName(prop);
    return `            [${JSON.stringify(prop)}] = ${value},`;
  });

  const signature = `    public static Node ${name}(${params.join(", ")}) =>`;

  return {
    citable: "source" in (COMPONENTS[name as keyof typeof COMPONENTS] as { shape: object }).shape,
    code: `    /// <summary>${name}.</summary>
${signature}
        NodeBuilder.Build(
            ${JSON.stringify(name)},
            new Dictionary<string, object?>
            {
${assignments.join("\n")}
            });`,
  };
}

/**
 * Every member of a generated enum must be distinctly named.
 *
 * `string[]` and `string` both pascal-cased to `String` once, and the result
 * compiled while mapping every plain string parameter to `"string[]"` — a
 * silent type change on every action in the portal. A generator that emits a
 * plausible wrong answer is worse than one that stops.
 */
function distinct(values: readonly string[], what: string): readonly string[] {
  const seen = new Map<string, string>();
  for (const value of values) {
    const name = pascal(value);
    const claimed = seen.get(name);
    if (claimed !== undefined) {
      throw new Error(
        `${what}: ${JSON.stringify(value)} and ${JSON.stringify(claimed)} both name the C# member ${name}`,
      );
    }
    seen.set(name, value);
  }
  return values;
}

const components = COMPONENT_NAMES.map(emit);

const enumBlocks = [...enums.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, spec]) => {
    const members = spec.values
      .map(
        (value, index) =>
          `    /// <summary>The catalog value <c>${value}</c>.</summary>\n    ${spec.members[index]},`,
      )
      .join("\n\n");
    const cases = spec.values
      .map(
        (value, index) =>
          `            ${name}.${spec.members[index]} => ${JSON.stringify(value)},`,
      )
      .join("\n");
    return `/// <summary>Values the catalog accepts for this prop.</summary>
public enum ${name}
{
${members}
}

/// <summary>Converts generated enums to the values the wire format uses.</summary>
public static partial class WireValues
{
    /// <summary>The catalog value for a <see cref="${name}"/>.</summary>
    public static ${spec.wire} ToWire(this ${name} value) =>
        value switch
        {
${cases}
            _ => throw new ArgumentOutOfRangeException(nameof(value)),
        };
}`;
  })
  .join("\n\n");

const uiFile = `// <auto-generated>
//     GENERATED FROM THE CATALOG — DO NOT EDIT.
//
//     Run \`pnpm sdk:csharp\` to regenerate; \`pnpm sdk:check\` fails if this
//     file is stale. Catalog version ${CATALOG_VERSION}, ${COMPONENT_NAMES.length} components.
//
//     Props are named arguments; children go through .With(), because C# will
//     not accept params before optional arguments:
//
//         Ui.Page(title: "Fleet").With(
//             Ui.Grid(columns: 3).With(
//                 Ui.StatTile(label: "Vehicles", value: "12"),
//                 Ui.StatTile(label: "Active", value: "9", tone: Tone.Success)));
//
//     A misspelled prop or a wrong enum value does not compile.
// </auto-generated>
#nullable enable

namespace Portal.Sdk;

${enumBlocks}

/// <summary>Builders for every component in the hub's catalog.</summary>
public static class Ui
{
${components.map((component) => component.code).join("\n\n")}
}
`;

const protocolFile = `// <auto-generated>
//     GENERATED FROM @portal/protocol — DO NOT EDIT.
//
//     The protocol's vocabulary, emitted rather than retyped. A review found
//     the Python SDK sending a toast level of "danger" — a component tone the
//     hub refuses — because it had been hand-copied and got one word wrong.
//     Three languages means three chances to make that mistake.
// </auto-generated>
#nullable enable

namespace Portal.Sdk;

/// <summary>Constants the hub defines.</summary>
public static class Protocol
{
    /// <summary>The version this SDK emits.</summary>
    public const string Version = ${JSON.stringify(CURRENT_PROTOCOL_VERSION)};

    /// <summary>The components whose schema declares <c>source</c>.</summary>
    public static readonly IReadOnlySet<string> Citable = new HashSet<string>
    {
${COMPONENT_NAMES.filter((_, index) => components[index]?.citable === true)
  .map((name) => `        ${JSON.stringify(name)},`)
  .join("\n")}
    };
}

/// <summary>Toast levels. Note <c>Error</c>, not <c>Danger</c> — that is a component tone.</summary>
public enum ToastLevel
{
${distinct((jsonSchema(ToastSchema).properties?.["level"]?.enum ?? []).map(String), "level")
  .map((value) => `    /// <summary>The protocol value <c>${String(value)}</c>.</summary>\n    ${pascal(String(value))},`)
  .join("\n\n")}
}

/// <summary>What an action reports back.</summary>
public enum ActionOutcome
{
${distinct((jsonSchema(ActionResponseSchema).properties?.["outcome"]?.enum ?? []).map(String), "outcome")
  .map((value) => `    /// <summary>The protocol value <c>${String(value)}</c>.</summary>\n    ${pascal(String(value))},`)
  .join("\n\n")}
}

/// <summary>The type an action parameter carries. Screens take strings only.</summary>
/// <remarks>
/// A screen param arrives in a query string and is therefore always a string.
/// An action payload is JSON, where <c>{"quantity": 2}</c> and
/// <c>{"quantity": "2"}</c> are different values, so an action must say which
/// it expects — and the hub rejects an action parameter that does not.
/// </remarks>
public enum ParamType
{
${distinct((jsonSchema(ActionParamSchema).properties?.["type"]?.enum ?? []).map(String), "type")
  .map((value) => `    /// <summary>The protocol value <c>${String(value)}</c>.</summary>\n    ${pascal(String(value))},`)
  .join("\n\n")}
}

/// <summary>Who a satellite, screen or action is visible to. Default-deny.</summary>
public enum Audience
{
${distinct((jsonSchema(AudienceSchema).enum ?? []).map(String), "AudienceSchema")
  .map((value) => `    /// <summary>The protocol value <c>${String(value)}</c>.</summary>\n    ${pascal(String(value))},`)
  .join("\n\n")}
}

/// <summary>Converts protocol enums to the strings the wire format uses.</summary>
public static partial class WireValues
{
    /// <summary>The protocol string for a <see cref="ToastLevel"/>.</summary>
    public static string ToWire(this ToastLevel value) =>
        value switch
        {
${distinct((jsonSchema(ToastSchema).properties?.["level"]?.enum ?? []).map(String), "level")
  .map((value) => `            ToastLevel.${pascal(String(value))} => ${JSON.stringify(String(value))},`)
  .join("\n")}
            _ => throw new ArgumentOutOfRangeException(nameof(value)),
        };

    /// <summary>The protocol string for an <see cref="ActionOutcome"/>.</summary>
    public static string ToWire(this ActionOutcome value) =>
        value switch
        {
${distinct((jsonSchema(ActionResponseSchema).properties?.["outcome"]?.enum ?? []).map(String), "outcome")
  .map((value) => `            ActionOutcome.${pascal(String(value))} => ${JSON.stringify(String(value))},`)
  .join("\n")}
            _ => throw new ArgumentOutOfRangeException(nameof(value)),
        };

    /// <summary>The protocol string for a <see cref="ParamType"/>.</summary>
    public static string ToWire(this ParamType value) =>
        value switch
        {
${distinct((jsonSchema(ActionParamSchema).properties?.["type"]?.enum ?? []).map(String), "type")
  .map((value) => `            ParamType.${pascal(String(value))} => ${JSON.stringify(String(value))},`)
  .join("\n")}
            _ => throw new ArgumentOutOfRangeException(nameof(value)),
        };

    /// <summary>The protocol string for an <see cref="Audience"/>.</summary>
    public static string ToWire(this Audience value) =>
        value switch
        {
${distinct((jsonSchema(AudienceSchema).enum ?? []).map(String), "AudienceSchema")
  .map((value) => `            Audience.${pascal(String(value))} => ${JSON.stringify(String(value))},`)
  .join("\n")}
            _ => throw new ArgumentOutOfRangeException(nameof(value)),
        };
}
`;

const root = join(dirname(fileURLToPath(import.meta.url)), "Portal.Sdk");
const outputs: readonly (readonly [string, string])[] = [
  [join(root, "Ui.g.cs"), uiFile],
  [join(root, "Protocol.g.cs"), protocolFile],
];

if (process.argv.includes("--check")) {
  for (const [path, expected] of outputs) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current !== expected) {
      process.stderr.write(
        current === ""
          ? `${path} does not exist. Run \`pnpm sdk:csharp\`.\n`
          : `${path} is out of date. Run \`pnpm sdk:csharp\` and commit the result.\n`,
      );
      process.exit(1);
    }
  }
  process.stdout.write(`up to date — ${COMPONENT_NAMES.length} components\n`);
} else {
  for (const [path, contents] of outputs) writeFileSync(path, contents, "utf8");
  process.stdout.write(`wrote ${outputs.length} files — ${COMPONENT_NAMES.length} components\n`);
}
