import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "./loop";
import { azureClient } from "./azure";

/**
 * The Azure AI Foundry translation, tested without a model.
 *
 * Everything worth asserting here is the shape either side of `fetch`: the
 * URL and headers the request is sent with, what the loop's messages become
 * on the wire, and what a wire reply becomes back in the loop's shape —
 * including the JSON-string round trip a tool call's arguments make, which is
 * the one detail Azure's shape does not share with Anthropic's or Ollama's.
 */

const tools = [
  { name: "orders_list", description: "list orders", input_schema: { type: "object" } },
] as unknown as Parameters<ReturnType<typeof azureClient>["respond"]>[0]["tools"];

const client = (overrides: Partial<Parameters<typeof azureClient>[0]> = {}) =>
  azureClient({
    apiKey: "test-key",
    endpoint: "https://example.openai.azure.com/openai/v1",
    deployment: "gpt-5.4-mini",
    ...overrides,
  });

function stubFetch(...replies: readonly unknown[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const reply of replies) {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => reply });
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> =>
  JSON.parse((fetchMock.mock.calls[call]?.[1] as { body: string }).body) as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the request", () => {
  it("posts to the v1 chat-completions path, with or without a trailing slash", async () => {
    const fetchMock = stubFetch(
      { choices: [{ message: { role: "assistant", content: "hi" } }] },
      { choices: [{ message: { role: "assistant", content: "hi" } }] },
    );

    await client({ endpoint: "https://example.openai.azure.com/openai/v1/" }).respond({
      system: "s",
      messages: [],
      tools,
    });
    await client({ endpoint: "https://example.openai.azure.com/openai/v1" }).respond({
      system: "s",
      messages: [],
      tools,
    });

    const expected = "https://example.openai.azure.com/openai/v1/chat/completions";
    expect(fetchMock.mock.calls[0]?.[0]).toBe(expected);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(expected);
  });

  it("sends no api-version by default", async () => {
    // Measured against a live resource: the classic shape's api-version
    // values 400 with "API version not supported" here, and no param at all
    // is what a real request answers 200 to.
    const fetchMock = stubFetch({ choices: [{ message: { role: "assistant", content: "hi" } }] });

    await client().respond({ system: "s", messages: [], tools });

    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("api-version");
  });

  it("names the deployment as the body's model, not a URL path segment", async () => {
    const fetchMock = stubFetch({ choices: [{ message: { role: "assistant", content: "hi" } }] });

    await client().respond({ system: "s", messages: [], tools });

    expect(bodyOf(fetchMock)["model"]).toBe("gpt-5.4-mini");
  });

  it("authenticates with an api-key header, not a bearer token", async () => {
    const fetchMock = stubFetch({ choices: [{ message: { role: "assistant", content: "hi" } }] });

    await client().respond({ system: "s", messages: [], tools });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("test-key");
    expect(headers["authorization"]).toBeUndefined();
  });

  it("honors an explicit api version when one is set", async () => {
    const fetchMock = stubFetch({ choices: [{ message: { role: "assistant", content: "hi" } }] });

    await client({ apiVersion: "preview" }).respond({ system: "s", messages: [], tools });

    expect(fetchMock.mock.calls[0]?.[0]).toContain("api-version=preview");
  });

  it("leads with the system message", async () => {
    const fetchMock = stubFetch({ choices: [{ message: { role: "assistant", content: "hi" } }] });

    await client().respond({ system: "be helpful", messages: [], tools });

    const sent = bodyOf(fetchMock)["messages"] as { role: string; content: string }[];
    expect(sent[0]).toEqual({ role: "system", content: "be helpful" });
  });

  it("keeps prose alongside tool calls on one assistant message", async () => {
    // Unlike Ollama, Azure's wire format has no template quirk that drops tool
    // calls when content is present, so the two travel together.
    const fetchMock = stubFetch({ choices: [{ message: { role: "assistant", content: "hi" } }] });

    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me look that up." },
          { type: "tool_use", id: "call_1", name: "orders_list", input: { page: 2 } },
        ],
      },
    ];

    await client().respond({ system: "s", messages, tools });

    const sent = bodyOf(fetchMock)["messages"] as {
      role: string;
      content: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    }[];
    const assistant = sent.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Let me look that up.");
    expect(assistant?.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "orders_list", arguments: '{"page":2}' } },
    ]);
  });

  it("sends each tool result as its own message, keyed by tool_call_id", async () => {
    const fetchMock = stubFetch({ choices: [{ message: { role: "assistant", content: "hi" } }] });

    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "{}" },
          { type: "tool_result", tool_use_id: "call_2", content: "{}", is_error: true },
        ],
      },
    ];

    await client().respond({ system: "s", messages, tools });

    const sent = bodyOf(fetchMock)["messages"] as { role: string; tool_call_id?: string }[];
    const toolMessages = sent.filter((message) => message.role === "tool");
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual(["call_1", "call_2"]);
  });

  it("declares tools as functions", async () => {
    const fetchMock = stubFetch({ choices: [{ message: { role: "assistant", content: "hi" } }] });

    await client().respond({ system: "s", messages: [], tools });

    const sent = bodyOf(fetchMock)["tools"] as {
      type: string;
      function: { name: string; description: string; parameters: unknown };
    }[];
    expect(sent).toEqual([
      {
        type: "function",
        function: {
          name: "orders_list",
          description: "list orders",
          parameters: { type: "object" },
        },
      },
    ]);
  });
});

describe("what comes back", () => {
  it("parses a tool call's JSON-string arguments back into an object", async () => {
    stubFetch({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_9", type: "function", function: { name: "orders_list", arguments: "{\"page\":2}" } },
            ],
          },
        },
      ],
    });

    const reply = await client().respond({ system: "s", messages: [], tools });

    expect(reply.content).toEqual([
      { type: "tool_use", id: "call_9", name: "orders_list", input: { page: 2 } },
    ]);
  });

  it("keeps text and a tool call together in one reply", async () => {
    stubFetch({
      choices: [
        {
          message: {
            role: "assistant",
            content: "checking",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "orders_list", arguments: "{}" } }],
          },
        },
      ],
    });

    const reply = await client().respond({ system: "s", messages: [], tools });

    expect(reply.content).toEqual([
      { type: "text", text: "checking" },
      { type: "tool_use", id: "call_1", name: "orders_list", input: {} },
    ]);
  });

  it("refuses a tool call whose arguments are not valid JSON", async () => {
    stubFetch({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "orders_list", arguments: "not json" } }],
          },
        },
      ],
    });

    await expect(client().respond({ system: "s", messages: [], tools })).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("reports the body of a non-200 response, not only its status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad deployment" }),
    );

    await expect(client().respond({ system: "s", messages: [], tools })).rejects.toThrow(
      /400.*bad deployment/s,
    );
  });

  it("refuses a reply with no message at all", async () => {
    stubFetch({ choices: [] });
    await expect(client().respond({ system: "s", messages: [], tools })).rejects.toThrow(
      /no message/,
    );
  });

  it("raises a content filter refusal rather than returning it as an answer", async () => {
    stubFetch({ choices: [{ message: { role: "assistant", content: "" }, finish_reason: "content_filter" }] });

    await expect(client().respond({ system: "s", messages: [], tools })).rejects.toThrow(
      /declined to answer/,
    );
  });

  it("raises a length cutoff rather than acting on a truncated tool call", async () => {
    stubFetch({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "orders_list", arguments: "{}" } }],
          },
          finish_reason: "length",
        },
      ],
    });

    await expect(client().respond({ system: "s", messages: [], tools })).rejects.toThrow(
      /did not fit within the token budget/,
    );
  });
});
