import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditEvent, Principal } from "@portal/identity";
import { AuditEventSchema, tenantAuditKey } from "@portal/identity";
import { ManifestSchema } from "@portal/protocol";
import { SatelliteClient, SatelliteSchema, loadRegistry } from "@portal/registry";
import {
  buildSurface,
  invokeTool,
  shimTools,
  type JsonObjectSchema,
  type ToolDescriptor,
  type ToolTransport,
} from "@portal/mcp-gateway";
import { createApp } from "./app";
import { manifest } from "./screens";
import { OrderRepository, seedOrders } from "./repository";

/** Any key will do here; what matters is that one is required. */
const AUDIT_KEY = tenantAuditKey("test-root-key", "acme");

/**
 * The gateway against a real satellite, over a real socket.
 *
 * The unit tests build the surface from hand-written fixtures, which proves the
 * rules and nothing about whether this satellite's actual manifest survives
 * them. This boots the app, reads the manifest it really serves, and calls the
 * tools that fall out of it — including the governed write, twice, to watch the
 * confirmation gate hold and then let go.
 */

const SECRET = "gateway-integration-secret";

const principal = (over: Partial<Principal> = {}): Principal => ({
  sub: "agent@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read", "orders.write"],
  roles: ["leadership", "engineering", "finance"],
  ...over,
});

let server: Server;
let repository: OrderRepository;
let client: SatelliteClient;
let transport: ToolTransport;
let baseUrl: string;
const audits: AuditEvent[] = [];

/** The satellite entry as the committed registry file describes it. */
const registryEntry = (baseUrl: string) =>
  loadRegistry(
    `- id: orders
  displayName: Order Management
  baseUrl: ${baseUrl}
  owner: fulfillment-team
  # Matches what the satellite actually declares. The client refuses a manifest
  # claiming an audience its registry entry does not grant, so a fixture that
  # drifts from the real manifest fails every test in the file at once.
  audience: [internal, external]
  rbacScopes: [orders.read]
  tools:
    orders.approve:
      agentVisible: true
      requiresConfirmation: true
      rbacScopes: [orders.write]
      roles: [finance]
    orders.create:
      agentVisible: true
      requiresConfirmation: true
      rbacScopes: [orders.write]
    orders.update:
      agentVisible: true
      requiresConfirmation: true
      rbacScopes: [orders.write]
    orders.delete:
      agentVisible: false
      rbacScopes: [orders.write]
    orders.attach:
      agentVisible: false
      rbacScopes: [orders.write]
    orders.search:
      rbacScopes: [orders.read]
    orders.reconcile:
      agentVisible: true
      requiresConfirmation: true
      rbacScopes: [orders.write]
`,
    {},
  )[0];

/**
 * The derived schema of a shimmed tool.
 *
 * A descriptor's `inputSchema` is now either this or a satellite's own — an
 * MCP tool publishes a schema the gateway never reads, so the type refuses to
 * let anything index into it blind. Everything in this file is shimmed from a
 * manifest, so the narrowing is a fact, and asserting it makes that explicit
 * rather than casting it away.
 */
function derivedSchema(tool: ToolDescriptor | undefined): JsonObjectSchema {
  expect(tool?.source).toBe("pup");
  return tool!.inputSchema as JsonObjectSchema;
}

describe("the fixture above", () => {
  it("declares the same tool policies the committed registry does", () => {
    // The fixture says it "matches what the satellite actually declares", and
    // until now nothing checked. It had gone stale — three actions were added
    // to the real registry and the tests kept asserting the old surface.
    const committed = loadRegistry(
      readFileSync(new URL("../../../config/satellites.yaml", import.meta.url), "utf8"),
      { PORTAL_ORDERS_URL: "http://fixture.test" },
    ).find((satellite) => satellite.id === "orders");

    expect(committed).toBeDefined();
    expect(registryEntry("http://fixture.test")?.tools).toEqual(committed?.tools);
  });
});

beforeAll(async () => {
  repository = new OrderRepository(seedOrders());
  const app = createApp({ repository, principalSecret: SECRET });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const satellite = registryEntry(baseUrl);
  if (satellite === undefined) throw new Error("no satellite");

  client = new SatelliteClient({ satellite, principalSecret: SECRET });
  transport = {
    fetchScreen: (_satelliteId, screenId, params, who) => client.fetchScreen(screenId, params, who),
    invokeAction: (_satelliteId, actionId, params, who) =>
      client.invokeAction(actionId, params, who),
  };
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

async function surfaceFor(who: Principal) {
  const satellite = registryEntry(baseUrl);
  if (satellite === undefined) throw new Error("no satellite");

  const manifest = await client.fetchManifest();
  if (!manifest.ok) throw new Error(`manifest unavailable: ${manifest.reason}`);
  return buildSurface([{ satellite, manifest: manifest.value }], who);
}

const deps = (confirmed?: boolean) => ({
  transport,
  auditKey: AUDIT_KEY,
  onAudit: (event: AuditEvent) => audits.push(event),
  now: () => Date.now(),
  at: () => new Date().toISOString(),
  newId: () => `audit-${audits.length}`,
  ...(confirmed === undefined ? {} : { confirmed }),
});

describe("the surface this satellite actually offers", () => {
  it("projects its real manifest into callable tools", async () => {
    const surface = await surfaceFor(principal());
    // `orders__orders_attach` is deliberately absent; see the skip test below.
    expect(surface.tools.map((tool) => tool.name).sort()).toEqual([
      "orders__orders_approve",
      "orders__orders_create",
      "orders__orders_detail",
      "orders__orders_edit",
      "orders__orders_list",
      "orders__orders_new",
      "orders__orders_update",
    ]);
  });

  it("projects form screens as reads too, which is a known cost", async () => {
    // `orders.new` returns an empty form: a tool a model can call and learn
    // nothing from. It is here because the shim makes every screen a read by
    // default, and that default is deliberate — requiring a registry entry per
    // screen would mean adding a screen needed a hub deploy, which is the one
    // promise this architecture makes loudest.
    //
    // Asserted rather than quietly tolerated. At three satellites it is noise;
    // at twenty it is surface a model pays for on every turn, and the fix is a
    // screen-level hint in the manifest rather than a registry entry. Recorded
    // in PLAN.md's known limits.
    const surface = await surfaceFor(principal());
    const form = surface.tools.find((tool) => tool.name === "orders__orders_new");

    expect(form).toBeDefined();
    // It takes nothing and returns a blank form, so a model calling it spends
    // a turn and learns nothing. Noise rather than a governance hole — but
    // noise every model pays for on every turn, which is why it is written
    // down instead of shrugged at.
    expect(derivedSchema(form).required ?? []).toEqual([]);
  });

  it("lets an agent send a list, which it previously could not express", async () => {
    // Until `string[]` existed, `tags` could not be declared at all: the form
    // offered a MultiSelect and the agent surface had no way to carry one. The
    // two projections of one action did not have the same reach, and the gap
    // was load-bearing — the hazmat rule was judged against a list the caller
    // never sent.
    const surface = await surfaceFor(principal());
    const create = surface.byName.get("orders__orders_create");
    const tags = derivedSchema(create).properties?.["tags"];

    expect(tags).toMatchObject({ type: "array", items: { type: "string" } });
    // The choices constrain each entry, not the list. A model reading them as
    // constraining the array would think one value was the whole answer.
    expect(tags).toMatchObject({ items: { enum: expect.arrayContaining(["hazmat"]) } });
  });

  it("does not offer deletion to a model at all", async () => {
    // `orders.delete` is `agentVisible: false`, which is a stronger control
    // than confirmation: confirmation is a person reading a card, invisibility
    // is the model never raising it. For an irreversible write the second is
    // the one worth having.
    const surface = await surfaceFor(principal());
    expect(surface.byName.has("orders__orders_delete")).toBe(false);
  });

  it("describes every field of a create, so a model need not guess", async () => {
    // A write an agent can only half-specify is a write it will get wrong. The
    // schema comes from the satellite's own declaration, not from the registry.
    const surface = await surfaceFor(principal());
    const create = surface.byName.get("orders__orders_create");
    const properties = Object.keys(derivedSchema(create).properties ?? {}).sort();

    expect(properties).toContain("customer");
    expect(properties).toContain("dueBy");
    expect(properties).toContain("priority");
    expect(derivedSchema(create).required).toContain("contactEmail");
    // Enumerated so it picks from the list rather than inventing a value.
    expect(derivedSchema(create).properties?.["priority"]).toMatchObject({
      enum: ["standard", "express", "critical"],
    });
  });

  it("leaves the write nobody enabled off the surface", async () => {
    // `orders.refresh` is a write with no registry entry. Its absence is the
    // default-deny rule working, not an omission.
    const surface = await surfaceFor(principal());
    expect(surface.byName.has("orders__orders_refresh")).toBe(false);
  });

  it("skips exactly one thing, and says why", async () => {
    // Every skip is a satellite declaration the gateway could not use, and an
    // unexplained new one means a manifest changed in a way that quietly cost
    // the agent a capability. This one is deliberate: `orders.attach` requires
    // a file, and no model can produce bytes.
    const surface = await surfaceFor(principal());

    expect(surface.skipped).toEqual([
      {
        satelliteId: "orders",
        toolId: "orders.attach",
        reason: 'action requires a file in "document", which no agent can supply',
      },
    ]);
  });

  it("does not offer the upload as a tool a model could call", async () => {
    // Offering it would put a write on the surface that every call must fail,
    // and a refusal at the satellite reads as a broken integration rather than
    // a deliberate boundary.
    const surface = await surfaceFor(principal());
    expect(surface.byName.has("orders__orders_attach")).toBe(false);
  });

  it("leaves an optional file out of the schema rather than describing it as a string", async () => {
    // Described as `{ type: "string" }` it *validates*, so "an agent cannot
    // set this" is a sentence in a description and not a boundary — a model
    // puts a filename on the wire and a satellite that reads presence as
    // truthy believes a document arrived. Omitted, `additionalProperties:
    // false` refuses the call before anything is invoked.
    const widened = {
      ...manifest(),
      actions: manifest().actions.map((action) =>
        action.id === "orders.approve"
          ? {
              ...action,
              params: [
                ...(action.params ?? []),
                { name: "scan", type: "file" as const, required: false },
              ],
            }
          : action,
      ),
    };

    const surface = shimTools(registryEntry("http://unused.invalid")!, widened);
    const tool = surface.tools.find(
      (candidate) => candidate.targetId === "orders.approve" && candidate.kind === "write",
    );

    expect(tool).toBeDefined();
    expect(Object.keys(derivedSchema(tool).properties ?? {})).not.toContain("scan");
    expect(derivedSchema(tool).additionalProperties).toBe(false);
    // Still named, so a model knows the write is partial by design.
    expect(tool!.description).toContain("scan");
  });

  it("marks the enabled write as needing confirmation", async () => {
    const surface = await surfaceFor(principal());
    expect(surface.byName.get("orders__orders_approve")?.requiresConfirmation).toBe(true);
    expect(surface.byName.get("orders__orders_list")?.requiresConfirmation).toBe(false);
  });

  it("hides the write from a principal without the scope the registry demands", async () => {
    const surface = await surfaceFor(principal({ scopes: ["orders.read"] }));
    expect(surface.byName.has("orders__orders_approve")).toBe(false);
    expect(surface.byName.has("orders__orders_list")).toBe(true);
  });

  it("describes every tool with a schema the strict agent path will accept", async () => {
    const surface = await surfaceFor(principal());
    for (const tool of surface.tools) {
      expect(derivedSchema(tool).additionalProperties).toBe(false);
      for (const rejected of ["minLength", "maximum", "pattern", "format"]) {
        expect(JSON.stringify(tool.inputSchema)).not.toContain(rejected);
      }
    }
  });
});

describe("calling those tools for real", () => {
  it("returns a screen's rows as data rather than as a tree", async () => {
    const surface = await surfaceFor(principal());
    const result = await invokeTool(surface, "orders__orders_list", {}, principal(), deps());

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "read") return;
    const table = result.data.tables[0];
    expect(table?.columns.map((column) => column.key)).toContain("status");
    expect(table?.rows.length).toBeGreaterThan(0);
    // `statusTone` is presentation the satellite sends for the renderer, and it
    // is not a column, so it never reaches the model.
    expect(JSON.stringify(result.data)).not.toContain("statusTone");
  });

  it("passes a declared screen param through to the satellite", async () => {
    const pending = repository.list("acme").find((order) => order.status === "pending");
    const surface = await surfaceFor(principal());
    const result = await invokeTool(
      surface,
      "orders__orders_detail",
      { id: pending?.id ?? "" },
      principal(),
      deps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "read") return;
    expect(result.data.facts.map((fact) => fact.label)).toContain("Customer");
  });

  it("refuses the write until it is confirmed, and changes nothing meanwhile", async () => {
    const pending = repository.list("acme").find((order) => order.status === "pending");
    if (pending === undefined) throw new Error("no pending order to approve");

    const surface = await surfaceFor(principal());
    const refused = await invokeTool(
      surface,
      "orders__orders_approve",
      { id: pending.id },
      principal(),
      deps(false),
    );

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe("needs-confirmation");
    // The point of the gate: the satellite was never called.
    expect(repository.get("acme", pending.id)?.status).toBe("pending");
  });

  it("runs the write once confirmed, and the satellite really changes", async () => {
    const pending = repository.list("acme").find((order) => order.status === "pending");
    if (pending === undefined) throw new Error("no pending order to approve");

    const surface = await surfaceFor(principal());
    const result = await invokeTool(
      surface,
      "orders__orders_approve",
      { id: pending.id },
      principal(),
      deps(true),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "write") return;
    expect(result.outcome).toBe("ok");
    expect(repository.get("acme", pending.id)?.status).toBe("approved");
  });

  it("carries a list all the way to the satellite, where the rule can see it", async () => {
    // The schema shape is not the claim; this is. Before `string[]` the label
    // could not cross the gateway at all, so the hazmat rule was judged against
    // a list no agent could send. Both halves are asserted: the rule fires on
    // the labels the agent actually sent, and the labels are what gets stored.
    const surface = await surfaceFor(principal());
    const draft = {
      customer: "Hazard Co",
      contactEmail: "ops@hazard.example",
      total: 250,
      currency: "GBP",
      dueBy: "2999-01-01",
      priority: "standard" as const,
      expedited: false,
    };

    const refused = await invokeTool(
      surface,
      "orders__orders_create",
      { ...draft, tags: ["hazmat"] },
      principal(),
      deps(true),
    );
    expect(refused.ok).toBe(true);
    if (!refused.ok || refused.kind !== "write") return;
    expect(refused.outcome).toBe("validation");
    expect(refused.fieldErrors?.["notes"]).toMatch(/hazmat/i);

    const accepted = await invokeTool(
      surface,
      "orders__orders_create",
      { ...draft, tags: ["hazmat"], notes: "Handle with care." },
      principal(),
      deps(true),
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok || accepted.kind !== "write") return;
    expect(accepted.outcome).toBe("ok");
    expect(
      repository.list("acme").some((order) => order.tags.includes("hazmat")),
    ).toBe(true);
  });

  it("refuses a label outside the declared choices before the satellite is called", async () => {
    // The enum sits on `items`, so it constrains each entry. A model that read
    // it as constraining the array would send one value for the whole answer;
    // one that invents an entry is stopped here rather than by the satellite.
    const surface = await surfaceFor(principal());
    const result = await invokeTool(
      surface,
      "orders__orders_create",
      {
        customer: "Hazard Co",
        contactEmail: "ops@hazard.example",
        total: 250,
        currency: "GBP",
        dueBy: "2999-01-01",
        priority: "standard",
        tags: ["explosives"],
      },
      principal(),
      deps(true),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad-arguments");
  });

  it("cannot be talked into sending a parameter the satellite never declared", async () => {
    // The tool schema is what the model was given; it is not what the model is
    // held to. `tenantId` is the field that matters — the satellite scopes on
    // it, and it must come from the signed principal rather than an argument.
    const surface = await surfaceFor(principal());
    const result = await invokeTool(
      surface,
      "orders__orders_approve",
      { id: "ord-1001", tenantId: "globex" },
      principal(),
      deps(true),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad-arguments");
  });

  it("wrote a valid audit record for every one of those calls", async () => {
    // Including the refusals. A log that only records successes cannot tell
    // "nothing happened" from "an agent was stopped".
    expect(audits.length).toBeGreaterThan(0);
    for (const event of audits) expect(() => AuditEventSchema.parse(event)).not.toThrow();
    expect(audits.map((event) => event.outcome.status)).toContain("denied");
    expect(audits.map((event) => event.outcome.status)).toContain("ok");
  });
});

describe("the manifest this satellite serves", () => {
  it("declares parameters for every action, or the agent cannot call them", async () => {
    // The check that would have caught the gap this package was built into: an
    // action with no declared params is invisible to any agent, and nothing
    // about the satellite looks wrong when it happens.
    const manifest = ManifestSchema.parse(await (await fetch(`${baseUrl}/portal/manifest`)).json());
    for (const action of manifest.actions) {
      expect(action.params, `action ${action.id} declares no params`).toBeDefined();
    }
  });

  it("is a satellite the registry schema accepts as written", () => {
    expect(() =>
      SatelliteSchema.parse({
        id: "orders",
        displayName: "Order Management",
        baseUrl: "http://localhost:4001",
        owner: "fulfillment-team",
        tools: { "orders.approve": { agentVisible: true, requiresConfirmation: true } },
      }),
    ).not.toThrow();
  });
});
