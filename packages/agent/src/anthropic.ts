import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, Message, ModelClient } from "./loop";

/**
 * The SDK, behind the seam.
 *
 * This is the only file in the package that knows a model vendor exists, and
 * the only one that cannot be tested without a network. Everything the loop
 * does — the tool surface, the confirmation gate, grounding — is a pure
 * function above it. That split is deliberate: PLAN.md rates the model as the
 * fastest-decaying dependency in the stack, at six to eighteen months, so it
 * sits behind the smallest interface in the repository.
 */

/**
 * Zero-data-retention eligible, which is why it and not a more capable sibling.
 * PLAN.md treats the model choice as a compliance decision before a capability
 * one, and regulated data reaches this call through tool results.
 */
export const AGENT_MODEL = "claude-opus-5";

/**
 * Enough for a screen of any size this catalog can express, and not so much
 * that a runaway generation is expensive before `maxTurns` notices.
 */
const MAX_TOKENS = 8192;

export interface AnthropicClientOptions {
  readonly apiKey: string;
  readonly model?: string;
}

export function anthropicClient(options: AnthropicClientOptions): ModelClient {
  const client = new Anthropic({ apiKey: options.apiKey });
  const model = options.model ?? AGENT_MODEL;

  return {
    async respond({ system, messages, tools }) {
      const message = await client.beta.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system,
        // Adaptive rather than a token budget: `budget_tokens` is rejected
        // outright on this model generation, and the work here varies from
        // "answer from one lookup" to "compose a cross-satellite screen".
        thinking: { type: "adaptive" },
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema as Anthropic.Beta.BetaTool["input_schema"],
        })),
        messages: messages.map(toSdkMessage),
      });

      // Two stop reasons produce content the loop cannot use, and both look
      // like an ordinary success to a caller that only reads `content`.
      //
      // A refusal arrives as HTTP 200 with the content empty, so the loop would
      // see no tool call, take the empty text for an answer, and the user would
      // get a blank reply. Truncation is worse: a `tool_use` cut off mid-input
      // is a tool call with half its arguments, which the loop would go on to
      // make. Both are raised so the route can say something true instead.
      if (message.stop_reason === "refusal") {
        throw new Error("The model declined to answer this request.");
      }
      if (message.stop_reason === "max_tokens") {
        throw new Error("The model's reply did not fit within the token budget.");
      }

      return { content: message.content.map(fromSdkBlock) };
    },
  };
}

function toSdkMessage(message: Message): Anthropic.Beta.BetaMessageParam {
  return {
    role: message.role,
    content: message.content.map(toSdkBlock) as Anthropic.Beta.BetaMessageParam["content"],
  };
}

function toSdkBlock(block: ContentBlock): unknown {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error === true ? { is_error: true } : {}),
      };
    case "opaque":
      // Straight back out the way it came in. A thinking block carries a
      // signature that only verifies if the block is byte-identical, so
      // anything this file does not understand it must not touch.
      return block.raw;
  }
}

function fromSdkBlock(block: Anthropic.Beta.BetaContentBlock): ContentBlock {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: (block.input ?? {}) as Record<string, unknown>,
    };
  }
  return { type: "opaque", raw: block };
}
