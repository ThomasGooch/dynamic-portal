import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "./loop";
import { ollamaClient } from "./ollama";

/**
 * The local provider's translation, tested without a model.
 *
 * Everything worth asserting here is the shape either side of `fetch`: what
 * Ollama is sent for a conversation the loop built, and what the loop is handed
 * back. Both directions had a bug that only shows up on the *second* turn,
 * which is exactly the kind a single-turn test cannot see.
 */

const tools = [
  { name: "orders_list", description: "list orders", input_schema: { type: "object" } },
] as unknown as Parameters<ReturnType<typeof ollamaClient>["respond"]>[0]["tools"];

function stubFetch(...replies: readonly unknown[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const reply of replies) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => reply,
    });
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> =>
  JSON.parse((fetchMock.mock.calls[call]?.[1] as { body: string }).body) as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("minting a tool call id", () => {
  it("does not reuse an id the conversation has already answered", async () => {
    // Ollama's native API returns no id, so one is minted — and the whole
    // conversation travels with the request, so a fresh client on the next turn
    // must not hand out `local_1` again. It did, and the loop then read the new
    // call as already answered, never ran it, and burned every turn it had.
    const fetchMock = stubFetch({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "orders_list", arguments: {} } }],
      },
    });

    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "how many orders?" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "local_1", name: "orders_list", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "local_1", content: "{}" }],
      },
      { role: "user", content: [{ type: "text", text: "and now?" }] },
    ];

    const reply = await ollamaClient().respond({ system: "s", messages: history, tools });

    expect(reply.content).toEqual([
      { type: "tool_use", id: "local_2", name: "orders_list", input: {} },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps two calls in one reply apart", async () => {
    stubFetch({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "orders_list", arguments: {} } },
          { function: { name: "orders_list", arguments: { page: 2 } } },
        ],
      },
    });

    const reply = await ollamaClient().respond({ system: "s", messages: [], tools });

    expect(reply.content.map((block) => (block.type === "tool_use" ? block.id : ""))).toEqual([
      "local_1",
      "local_2",
    ]);
  });

  it("keeps an id the model did supply", async () => {
    stubFetch({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_abc", function: { name: "orders_list", arguments: {} } }],
      },
    });

    const reply = await ollamaClient().respond({ system: "s", messages: [], tools });

    expect(reply.content[0]).toMatchObject({ type: "tool_use", id: "call_abc" });
  });
});

describe("what Ollama is sent", () => {
  it("names the tool on a tool result, not the call id", async () => {
    const fetchMock = stubFetch({ message: { role: "assistant", content: "seven" } });

    await ollamaClient().respond({
      system: "s",
      messages: [
        { role: "user", content: [{ type: "text", text: "how many?" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "local_1", name: "orders_list", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "local_1", content: "{}" }],
        },
      ],
      tools,
    });

    const sent = bodyOf(fetchMock)["messages"] as { role: string; tool_name?: string }[];
    const toolMessage = sent.find((message) => message.role === "tool");
    expect(toolMessage?.tool_name).toBe("orders_list");
  });

  it("never sends prose alongside tool calls", async () => {
    // Ollama renders history through the model's own Go template, and
    // qwen2.5's is `{{ if .Content }}…{{ else if .ToolCalls }}…` — an `else`.
    // Any content at all drops every call from the prompt, and the model is
    // then shown a tool response for a call it cannot see it made. Splitting
    // the two across messages is not a way out either: Ollama merges
    // consecutive messages of the same role before templating.
    const fetchMock = stubFetch({ message: { role: "assistant", content: "seven" } });

    await ollamaClient().respond({
      system: "s",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me look that up." },
            { type: "tool_use", id: "local_1", name: "orders_list", input: {} },
          ],
        },
      ],
      tools,
    });

    const sent = bodyOf(fetchMock)["messages"] as {
      role: string;
      content: string;
      tool_calls?: unknown[];
    }[];
    const assistants = sent.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.content).toBe("");
    expect(assistants[0]?.tool_calls).toHaveLength(1);
  });

  it("posts to the host given, with or without a trailing slash", async () => {
    const fetchMock = stubFetch(
      { message: { role: "assistant", content: "hi" } },
      { message: { role: "assistant", content: "hi" } },
    );

    await ollamaClient({ baseUrl: "http://ollama:11434/" }).respond({
      system: "s",
      messages: [],
      tools,
    });
    await ollamaClient({ baseUrl: "http://ollama:11434" }).respond({
      system: "s",
      messages: [],
      tools,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://ollama:11434/api/chat");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://ollama:11434/api/chat");
  });
});

describe("what comes back", () => {
  it("reports the body of a refusal, not only its status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'model "" not found',
      }),
    );

    await expect(
      ollamaClient().respond({ system: "s", messages: [], tools }),
    ).rejects.toThrow(/400.*not found/s);
  });

  it("refuses a reply with no message at all", async () => {
    stubFetch({});
    await expect(ollamaClient().respond({ system: "s", messages: [], tools })).rejects.toThrow(
      /no message/,
    );
  });

  it("says the server is unreachable rather than `fetch failed`", async () => {
    // The advice about `ollama serve` only ever reached people whose Ollama
    // was already running: a daemon that is not started never answers, so
    // `fetch` rejects before any status exists to explain.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    await expect(
      ollamaClient({ baseUrl: "http://ollama:11434" }).respond({
        system: "s",
        messages: [],
        tools,
      }),
    ).rejects.toThrow(/could not reach the local model at http:\/\/ollama:11434.*ollama serve/s);
  });

  it("names the timeout as a timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("The operation timed out", "TimeoutError")),
    );

    await expect(
      ollamaClient({ timeoutMs: 1000 }).respond({ system: "s", messages: [], tools }),
    ).rejects.toThrow(/did not answer within 1000ms/);
  });

  it("refuses a reply the context window cut off", async () => {
    // The mirror of the hosted client's `max_tokens` throw. A generation cut
    // short can end part way through a tool call, and the loop would go on to
    // make it with half its arguments — while the HTTP call is a clean 200.
    stubFetch({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "orders_list", arguments: {} } }],
      },
      done_reason: "length",
    });

    await expect(ollamaClient().respond({ system: "s", messages: [], tools })).rejects.toThrow(
      /cut off/,
    );
  });
});
