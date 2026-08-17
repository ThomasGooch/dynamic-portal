import type { ToolSurface } from "@portal/mcp-gateway";
import { RENDER_SCREEN_SCHEMA } from "./schema";

/**
 * The tools a model is given: everything the gateway says this principal may
 * call, plus the one tool that draws a screen.
 *
 * Nothing is added to the surface here and nothing is filtered out of it. The
 * gateway already decided what is visible, using the same `authorize` the
 * screen route uses; a second opinion in this file would be a second policy
 * engine, and two of those disagree eventually.
 */

/** The tool through which every agent-composed screen arrives. */
export const RENDER_SCREEN_TOOL = "render_screen";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export function toolDefinitions(surface: ToolSurface): ToolDefinition[] {
  const tools: ToolDefinition[] = surface.tools.map((tool) => ({
    name: tool.name,
    // The confirmation requirement is stated in the description as well as
    // enforced in the gateway. Enforcement is what makes it true; saying so is
    // what stops the model spending a turn discovering it.
    description: tool.requiresConfirmation
      ? `${tool.description} This changes data and will pause for the user to confirm.`
      : tool.description,
    input_schema: tool.inputSchema as unknown as Record<string, unknown>,
  }));

  tools.push({
    name: RENDER_SCREEN_TOOL,
    description: RENDER_SCREEN_DESCRIPTION,
    input_schema: RENDER_SCREEN_SCHEMA,
  });

  return tools;
}

/**
 * Everything the model needs to know that the schema cannot express.
 *
 * The rules it *can* express are not repeated here — a property the schema
 * omits needs no prose telling the model not to use it. What is left is the
 * part a schema has no vocabulary for: which tool call a node should cite, and
 * that the hub will refuse the screen if the citation does not hold up.
 */
const RENDER_SCREEN_DESCRIPTION = [
  "Draw a screen for the user from data you have already fetched.",
  "",
  "Every element is one entry in `elements`, referring to its children by id; `root` names the outermost one.",
  "",
  "Nodes that show data — StatTile, KeyValueList, Table, Chart — must carry `source.toolCallId`",
  "naming the tool call the data came from. Tables and charts carry no data of their own:",
  "declare the columns or series you want and the portal fills them in from that call.",
  "A value you write yourself, such as a StatTile value, has to appear in that call's result,",
  "so quote figures exactly as the tool reported them rather than rounding or recomputing.",
  "",
  "If a citation does not hold up the whole screen is refused and you will be told which node failed.",
].join("\n");

/**
 * How the agent is told to behave. Deliberately short.
 *
 * Every rule that can be enforced is enforced somewhere else — the gateway
 * decides what may be called, the schema decides what may be drawn, the
 * grounding pass decides what may be shown. A prompt repeating those would be
 * a fourth statement of a rule that already has three, and the one that goes
 * stale.
 */
export const SYSTEM_PROMPT = [
  "You are the assistant inside a company portal that fronts several internal solutions.",
  "",
  "Answer from the tools. They are the only source of fact you have, and the portal",
  "will not display a figure that did not come from one.",
  "",
  "When the answer is a list, a comparison or anything with more than a couple of numbers in it,",
  "draw it with render_screen rather than describing it in prose. When it is a single fact or a",
  "direct question about what you just did, say it plainly instead.",
  "",
  "Tools that change data pause for the user to approve them. Call one when the user has asked",
  "for the change; do not call one to find something out.",
  "",
  "If the tools cannot answer the question, say so and say what is missing. Do not fill a gap",
  "with a plausible number.",
].join("\n");
