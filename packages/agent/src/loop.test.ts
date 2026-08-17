import type { ExtractedData, ToolResult, ToolSurface } from "@portal/mcp-gateway";
import { beforeEach, describe, expect, it } from "vitest";
import { runAgent, type ContentBlock, type Message, type ModelClient } from "./loop";
import { RENDER_SCREEN_TOOL } from "./tools";

const emptyData: ExtractedData = { tables: [], stats: [], facts: [], charts: [], text: [] };

const ordersData: ExtractedData = {
  ...emptyData,
  stats: [{ label: "Pending", value: "2" }],
  tables: [
    {
      columns: [
        { key: "id", label: "Order" },
        { key: "status", label: "Status" },
      ],
      rows: [
        { id: "ord-1", status: "pending" },
        { id: "ord-2", status: "approved" },
      ],
      rowCount: 2,
      truncated: false,
    },
  ],
};

const surface = {
  tools: [
    {
      name: "orders__orders_list",
      satelliteId: "orders",
      kind: "read" as const,
      targetId: "orders.list",
      title: "Orders",
      description: "Read the orders list.",
      inputSchema: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const },
      audience: ["internal" as const],
      rbacScopes: [],
      requiresConfirmation: false,
      agentVisible: true,
    },
    {
      name: "orders__orders_approve",
      satelliteId: "orders",
      kind: "write" as const,
      targetId: "orders.approve",
      title: "Approve order",
      description: "Approve an order.",
      inputSchema: {
        type: "object" as const,
        properties: { id: { type: "string" as const } },
        required: ["id"],
        additionalProperties: false as const,
      },
      audience: ["internal" as const],
      rbacScopes: ["orders.write"],
      requiresConfirmation: true,
      agentVisible: true,
    },
  ],
  byName: new Map(),
  skipped: [],
} as unknown as ToolSurface;
(surface.byName as Map<string, unknown>).set("orders__orders_list", surface.tools[0]);
(surface.byName as Map<string, unknown>).set("orders__orders_approve", surface.tools[1]);

const ask = (text: string): Message[] => [{ role: "user", content: [{ type: "text", text }] }];

/** A model whose turns are written down in advance. */
function scripted(...turns: ContentBlock[][]): ModelClient & { calls: number } {
  const client = {
    calls: 0,
    async respond() {
      const content = turns[client.calls];
      client.calls += 1;
      if (content === undefined) throw new Error("the model was asked for more turns than scripted");
      return { content };
    },
  };
  return client;
}

const toolUse = (id: string, name: string, input: Record<string, unknown> = {}): ContentBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});

const screenSpec = (toolCallId: string) => ({
  root: "page",
  elements: [
    { id: "page", type: "Page", props: {}, children: ["stat"] },
    {
      id: "stat",
      type: "StatTile",
      props: { label: "Pending", value: "2", source: { toolCallId } },
    },
  ],
});

let invoked: { name: string; args: Record<string, unknown>; confirmed: boolean }[];

const invoker =
  (result: ToolResult = { ok: true, kind: "read", data: ordersData }) =>
  async (name: string, args: Record<string, unknown>, options: { confirmed: boolean }) => {
    invoked.push({ name, args, confirmed: options.confirmed });
    if (name === "orders__orders_approve" && !options.confirmed) {
      return { ok: false, reason: "needs-confirmation", message: "needs confirming" } as ToolResult;
    }
    return result;
  };

beforeEach(() => {
  invoked = [];
});

describe("answering without drawing", () => {
  it("returns prose when the model just talks", async () => {
    const result = await runAgent(
      { messages: ask("hello"), surface },
      { client: scripted([{ type: "text", text: "Two orders are pending." }]), invoke: invoker() },
    );

    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") return;
    expect(result.text).toBe("Two orders are pending.");
    expect(invoked).toEqual([]);
  });

  it("calls a read and feeds the result back before answering", async () => {
    const client = scripted(
      [toolUse("call-1", "orders__orders_list")],
      [{ type: "text", text: "Two are pending." }],
    );

    const result = await runAgent({ messages: ask("how many?"), surface }, { client, invoke: invoker() });

    expect(result.kind).toBe("answer");
    expect(invoked).toEqual([{ name: "orders__orders_list", args: {}, confirmed: false }]);
    // The result the model saw is in the history, which is what grounding
    // later checks against.
    const results = result.messages.flatMap((message) =>
      message.content.filter((block) => block.type === "tool_result"),
    );
    expect(results).toHaveLength(1);
  });
});

describe("what a read result tells the model", () => {
  it("carries the id the model is required to cite", async () => {
    // The bug this pins cost every turn the loop had. Grounding demands a
    // `toolCallId` and nothing told the model what one was, so it cited the
    // tool's *name* — twice, with different punctuation — and the turn ran out.
    // The id lives in the model's own `tool_use` block, which turns out not to
    // be the same as being told.
    const client = scripted(
      [toolUse("call-1", "orders__orders_list")],
      [{ type: "text", text: "done" }],
    );
    const result = await runAgent({ messages: ask("go"), surface }, { client, invoke: invoker() });

    const payload = result.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result")
      .map((block) => JSON.parse((block as { content: string }).content) as { toolCallId?: string });

    expect(payload[0]?.toolCallId).toBe("call-1");
  });
});

describe("drawing a screen", () => {
  it("grounds the spec against the calls that actually happened", async () => {
    const client = scripted(
      [toolUse("call-1", "orders__orders_list")],
      [toolUse("draw-1", RENDER_SCREEN_TOOL, screenSpec("call-1"))],
    );

    const result = await runAgent({ messages: ask("show me"), surface }, { client, invoke: invoker() });

    expect(result.kind).toBe("screen");
    if (result.kind !== "screen") return;
    expect(result.spec.root).toBe("page");
    expect(result.citations).toEqual([{ toolCallId: "call-1", toolName: "orders__orders_list" }]);
  });

  it("hands an ungrounded screen back to the model instead of failing the turn", async () => {
    // The issue messages exist to be read by the thing that can fix them.
    const client = scripted(
      [toolUse("call-1", "orders__orders_list")],
      [toolUse("draw-1", RENDER_SCREEN_TOOL, screenSpec("invented"))],
      [toolUse("draw-2", RENDER_SCREEN_TOOL, screenSpec("call-1"))],
    );

    const result = await runAgent({ messages: ask("show me"), surface }, { client, invoke: invoker() });

    expect(result.kind).toBe("screen");
    expect(client.calls).toBe(3);
  });

  it("grounds against a read made in the same turn as the drawing", async () => {
    // The model writes its own tool_use ids, so it can fetch and draw in one
    // message and cite an id it has just emitted. Grounding that only looked at
    // the history refused this — the read's result had not been appended yet —
    // and told the model nothing had been fetched, which was untrue and cost a
    // turn.
    const client = scripted([
      toolUse("call-1", "orders__orders_list"),
      toolUse("draw-1", RENDER_SCREEN_TOOL, screenSpec("call-1")),
    ]);

    const result = await runAgent({ messages: ask("show me"), surface }, { client, invoke: invoker() });

    expect(result.kind).toBe("screen");
    expect(client.calls).toBe(1);
  });

  it("names the ids that would have worked, not merely the one that did not", async () => {
    // A retry after "that id does not exist" is another guess unless the
    // message says what does exist.
    const client = scripted(
      [toolUse("call-1", "orders__orders_list")],
      [toolUse("draw-1", RENDER_SCREEN_TOOL, screenSpec("invented"))],
      [{ type: "text", text: "I see." }],
    );
    const result = await runAgent({ messages: ask("show me"), surface }, { client, invoke: invoker() });

    const error = result.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result" && block.is_error === true);
    expect((error as { content: string }).content).toContain("call-1");
  });

  it("says so plainly when nothing has been fetched yet", async () => {
    const client = scripted(
      [toolUse("draw-1", RENDER_SCREEN_TOOL, screenSpec("invented"))],
      [{ type: "text", text: "Sorry." }],
    );
    const result = await runAgent({ messages: ask("show me"), surface }, { client, invoke: invoker() });

    const error = result.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result" && block.is_error === true);
    expect((error as { content: string }).content).toMatch(/no tool call has happened yet/i);
  });

  it("tells the model which node was wrong", async () => {
    const client = scripted(
      [toolUse("call-1", "orders__orders_list")],
      [toolUse("draw-1", RENDER_SCREEN_TOOL, screenSpec("invented"))],
      [{ type: "text", text: "I could not." }],
    );

    const result = await runAgent({ messages: ask("show me"), surface }, { client, invoke: invoker() });

    const errors = result.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result" && block.is_error === true);
    expect(errors).toHaveLength(1);
    expect((errors[0] as { content: string }).content).toContain("stat");
    expect((errors[0] as { content: string }).content).toContain("invented");
  });

  it("refuses a screen citing a call from a turn that never ran", async () => {
    const client = scripted([toolUse("draw-1", RENDER_SCREEN_TOOL, screenSpec("call-1"))], [
      { type: "text", text: "Sorry." },
    ]);

    const result = await runAgent({ messages: ask("show me"), surface }, { client, invoke: invoker() });
    expect(result.kind).toBe("answer");
  });
});

describe("the confirmation gate", () => {
  it("stops at a write and reports what is waiting", async () => {
    const client = scripted([toolUse("write-1", "orders__orders_approve", { id: "ord-1" })]);

    const result = await runAgent(
      { messages: ask("approve ord-1"), surface },
      { client, invoke: invoker() },
    );

    expect(result.kind).toBe("confirm");
    if (result.kind !== "confirm") return;
    expect(result.pending).toMatchObject({
      toolUseId: "write-1",
      toolName: "orders__orders_approve",
      title: "Approve order",
      args: { id: "ord-1" },
    });
  });

  it("leaves the unanswered call in the history, which is what lets it resume", async () => {
    const client = scripted([toolUse("write-1", "orders__orders_approve", { id: "ord-1" })]);
    const result = await runAgent({ messages: ask("approve"), surface }, { client, invoke: invoker() });

    if (result.kind !== "confirm") throw new Error("expected a confirmation");
    const last = result.messages[result.messages.length - 1];
    expect(last?.role).toBe("assistant");
    expect(last?.content.some((block) => block.type === "tool_use")).toBe(true);
    expect(
      result.messages.flatMap((m) => m.content).some((block) => block.type === "tool_result"),
    ).toBe(false);
  });

  it("runs the write on the next turn once it is approved, without asking the model again", async () => {
    const first = scripted([toolUse("write-1", "orders__orders_approve", { id: "ord-1" })]);
    const paused = await runAgent({ messages: ask("approve"), surface }, { client: first, invoke: invoker() });
    if (paused.kind !== "confirm") throw new Error("expected a confirmation");

    invoked = [];
    const resumed = scripted([{ type: "text", text: "Approved." }]);
    const result = await runAgent(
      { messages: paused.messages, surface, approvals: ["write-1"] },
      {
        client: resumed,
        invoke: invoker({ ok: true, kind: "write", outcome: "ok", message: "Order approved." }),
      },
    );

    expect(result.kind).toBe("answer");
    expect(invoked).toEqual([
      { name: "orders__orders_approve", args: { id: "ord-1" }, confirmed: true },
    ]);
    // One model turn, not two: the assistant's tool call was already made.
    expect(resumed.calls).toBe(1);
  });

  it("approving one call does not approve another", async () => {
    const client = scripted([toolUse("write-2", "orders__orders_approve", { id: "ord-2" })]);
    const result = await runAgent(
      { messages: ask("approve"), surface, approvals: ["write-1"] },
      { client, invoke: invoker() },
    );
    expect(result.kind).toBe("confirm");
  });

  it("asks the gateway about the unapproved write, and nothing else", async () => {
    // The gateway refuses without reaching the satellite, and that refusal is
    // the audit record for a stopped write. Skipping the call entirely was
    // tidier and silently lost the entry that matters most.
    const client = scripted([toolUse("write-1", "orders__orders_approve", { id: "ord-1" })]);
    await runAgent({ messages: ask("approve"), surface }, { client, invoke: invoker() });
    expect(invoked).toEqual([
      { name: "orders__orders_approve", args: { id: "ord-1" }, confirmed: false },
    ]);
  });

  it("runs nothing at all when a write shares its turn with a read", async () => {
    // The reason the check happens before the loop rather than inside it: a
    // `tool_use` block is answered all at once or not at all, so stopping
    // half-way threw away the read's result and ran it again on resume — a
    // duplicate satellite call, a duplicate audit entry, and a second write if
    // a policy had cleared its confirmation.
    const client = scripted([
      toolUse("call-1", "orders__orders_list"),
      toolUse("write-1", "orders__orders_approve", { id: "ord-1" }),
    ]);

    const result = await runAgent({ messages: ask("do both"), surface }, { client, invoke: invoker() });

    expect(result.kind).toBe("confirm");
    // Only the write, and only to be refused. The read beside it never ran, so
    // it cannot run twice when the turn resumes.
    expect(invoked).toEqual([
      { name: "orders__orders_approve", args: { id: "ord-1" }, confirmed: false },
    ]);
  });

  it("runs the whole turn once the write in it is approved", async () => {
    const client = scripted([{ type: "text", text: "Done." }]);

    const resumed = await runAgent(
      {
        messages: [
          ...ask("do both"),
          {
            role: "assistant",
            content: [
              toolUse("call-1", "orders__orders_list"),
              toolUse("write-1", "orders__orders_approve", { id: "ord-1" }),
            ],
          },
        ],
        surface,
        approvals: ["write-1"],
      },
      { client, invoke: invoker() },
    );

    expect(resumed.kind).toBe("answer");
    // Each call made exactly once, which is the property the pre-check buys.
    expect(invoked.map((call) => call.name).sort()).toEqual([
      "orders__orders_approve",
      "orders__orders_list",
    ]);
  });
});

describe("limits", () => {
  it("stops rather than looping forever", async () => {
    // A model that will not stop is a bill, not a bug report.
    const client = scripted(
      ...Array.from({ length: 10 }, () => [toolUse(`call-${Math.random()}`, "orders__orders_list")]),
    );

    const result = await runAgent(
      { messages: ask("go"), surface },
      { client, invoke: invoker(), maxTurns: 4 },
    );

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.reason).toMatch(/turns/i);
  });

  it("passes a failing tool result back rather than aborting", async () => {
    const client = scripted(
      [toolUse("call-1", "orders__orders_list")],
      [{ type: "text", text: "That solution is unavailable." }],
    );

    const result = await runAgent(
      { messages: ask("go"), surface },
      {
        client,
        invoke: async () => ({ ok: false, reason: "unavailable", message: "not responding" }),
      },
    );

    expect(result.kind).toBe("answer");
    const errors = result.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result" && block.is_error === true);
    expect(errors).toHaveLength(1);
  });
});
