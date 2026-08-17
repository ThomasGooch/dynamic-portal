import { tenantAuditKey } from "@portal/identity";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RENDER_SCREEN_TOOL,
  runAgent,
  type ContentBlock,
  type Message,
  type ModelClient,
} from "@portal/agent";
import type { AuditEvent, Principal } from "@portal/identity";
import { buildSurface, invokeTool, type ToolSurface, type ToolTransport } from "@portal/mcp-gateway";
import { SatelliteClient, loadRegistry } from "@portal/registry";
import { createApp } from "./app";
import { OrderRepository, seedOrders } from "./repository";

/** Any key will do here; what matters is that one is required. */
const AUDIT_KEY = tenantAuditKey("test-root-key", "acme");

/**
 * The agent loop against a real satellite, with a scripted model.
 *
 * Everything here is real except the vendor: a real registry entry, a real
 * manifest read over a socket, the real gateway, real PUP calls, and the real
 * grounding pass. Only the model's turns are written down in advance, because a
 * test that depends on what a model chooses to say is a test that fails for
 * reasons nobody can fix.
 *
 * What this leaves untested is exactly one file — the SDK adapter — and that is
 * the point of it being one file.
 */

const SECRET = "agent-integration-secret";

const principal: Principal = {
  sub: "agent@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read", "orders.write"],
};

let server: Server;
let baseUrl: string;
let repository: OrderRepository;
let surface: ToolSurface;
let transport: ToolTransport;
const audits: AuditEvent[] = [];

const registryEntry = (url: string) =>
  loadRegistry(
    `- id: orders
  displayName: Order Management
  baseUrl: ${url}
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
`,
    {},
  )[0];

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

  const client = new SatelliteClient({ satellite, principalSecret: SECRET });
  transport = {
    fetchScreen: (_id, screenId, params, who) => client.fetchScreen(screenId, params, who),
    invokeAction: (_id, actionId, params, who) => client.invokeAction(actionId, params, who),
  };

  const manifest = await client.fetchManifest();
  if (!manifest.ok) throw new Error("manifest unavailable");
  surface = buildSurface([{ satellite, manifest: manifest.value }], principal);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

const invoke = (name: string, args: Record<string, unknown>, options: { confirmed: boolean }) =>
  invokeTool(surface, name, args, principal, {
    transport,
    auditKey: AUDIT_KEY,
    onAudit: (event) => audits.push(event),
    now: () => Date.now(),
    at: () => new Date().toISOString(),
    newId: () => `audit-${audits.length}`,
    confirmed: options.confirmed,
  });

function scripted(...turns: ContentBlock[][]): ModelClient & { calls: number } {
  const client = {
    calls: 0,
    async respond() {
      const content = turns[client.calls];
      client.calls += 1;
      if (content === undefined) throw new Error("more turns requested than scripted");
      return { content };
    },
  };
  return client;
}

const ask = (text: string): Message[] => [{ role: "user", content: [{ type: "text", text }] }];

describe("reading through the whole stack", () => {
  it("answers from a real satellite's real rows", async () => {
    const client = scripted(
      [{ type: "tool_use", id: "call-1", name: "orders__orders_list", input: {} }],
      [{ type: "text", text: "There are orders pending." }],
    );

    const result = await runAgent({ messages: ask("how many?"), surface }, { client, invoke });

    expect(result.kind).toBe("answer");
    // The rows the model saw came off the wire, not out of a fixture.
    const shown = result.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result");
    expect((shown as { content: string }).content).toContain("ord-1001");
  });

  it("draws a screen whose numbers came from that read", async () => {
    const client = scripted(
      [{ type: "tool_use", id: "call-1", name: "orders__orders_list", input: {} }],
      [
        {
          type: "tool_use",
          id: "draw-1",
          name: RENDER_SCREEN_TOOL,
          input: {
            root: "page",
            elements: [
              { id: "page", type: "Page", props: { title: "Orders" }, children: ["table"] },
              {
                id: "table",
                type: "Table",
                props: {
                  columns: [
                    { key: "id", label: "Order" },
                    { key: "status", label: "Status" },
                  ],
                  source: { toolCallId: "call-1" },
                },
              },
            ],
          },
        },
      ],
    );

    const result = await runAgent({ messages: ask("show me"), surface }, { client, invoke });

    expect(result.kind).toBe("screen");
    if (result.kind !== "screen") return;

    const table = result.spec.elements.find((element) => element.id === "table");
    const rows = table?.props?.["rows"] as Record<string, unknown>[];
    // Filled by the hub from the satellite's own response — the model was never
    // able to write a row.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty("id");
    expect(result.citations).toEqual([{ toolCallId: "call-1", toolName: "orders__orders_list" }]);
  });

  it("refuses a screen whose number the satellite never reported", async () => {
    const client = scripted(
      [{ type: "tool_use", id: "call-1", name: "orders__orders_list", input: {} }],
      [
        {
          type: "tool_use",
          id: "draw-1",
          name: RENDER_SCREEN_TOOL,
          input: {
            root: "stat",
            elements: [
              {
                id: "stat",
                type: "StatTile",
                props: { label: "Pending", value: "9999", source: { toolCallId: "call-1" } },
              },
            ],
          },
        },
      ],
      [{ type: "text", text: "I could not verify that." }],
    );

    const result = await runAgent({ messages: ask("show me"), surface }, { client, invoke });

    expect(result.kind).toBe("answer");
    const errors = result.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result" && block.is_error === true);
    expect(errors).toHaveLength(1);
    expect((errors[0] as { content: string }).content).toContain("9999");
  });
});

describe("the governed write, end to end", () => {
  it("pauses, then really changes the satellite once approved", async () => {
    const pending = repository.list("acme").find((order) => order.status === "pending");
    if (pending === undefined) throw new Error("no pending order");

    const first = scripted([
      { type: "tool_use", id: "write-1", name: "orders__orders_approve", input: { id: pending.id } },
    ]);

    const paused = await runAgent(
      { messages: ask(`approve ${pending.id}`), surface },
      { client: first, invoke },
    );

    expect(paused.kind).toBe("confirm");
    if (paused.kind !== "confirm") return;
    expect(paused.pending.title).toBe("Approve order");
    // The gate held: nothing was written.
    expect(repository.get("acme", pending.id)?.status).toBe("pending");

    const resumed = scripted([{ type: "text", text: "Approved." }]);
    const done = await runAgent(
      { messages: paused.messages, surface, approvals: ["write-1"] },
      { client: resumed, invoke },
    );

    expect(done.kind).toBe("answer");
    expect(repository.get("acme", pending.id)?.status).toBe("approved");
    // One model turn to resume, because the assistant's call had already been made.
    expect(resumed.calls).toBe(1);
  });

  it("audited every call, including the refusal", async () => {
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.map((event) => event.outcome.status)).toContain("denied");
    expect(audits.map((event) => event.outcome.status)).toContain("ok");
  });
});

describe("what the agent cannot reach", () => {
  it("has no tool for the write nobody enabled", async () => {
    expect(surface.byName.has("orders__orders_refresh")).toBe(false);
  });

  it("refuses a tool the model invents", async () => {
    const client = scripted(
      [{ type: "tool_use", id: "call-1", name: "orders__delete_everything", input: {} }],
      [{ type: "text", text: "No such tool." }],
    );

    const result = await runAgent({ messages: ask("delete"), surface }, { client, invoke });
    expect(result.kind).toBe("answer");
    const errors = result.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result" && block.is_error === true);
    expect(errors).toHaveLength(1);
  });
});
