/**
 * What a model may say about a screen, and how the hub checks it.
 *
 * The agent composes layout; only tools supply facts. That sentence is the
 * whole package, and it is enforced in two places rather than asked for in a
 * prompt: the schema removes the properties that carry data, so a model has
 * nowhere to write a number it made up, and the grounding pass fills those
 * properties in from the tool call each node cites — refusing anything whose
 * citation does not hold up.
 *
 * Deliberately free of any model SDK. Everything here is a pure function over a
 * spec and a set of tool results, which is what makes the integrity claim
 * testable without a network.
 */

export {
  AUTHORED_BY_TOOLS,
  MUST_CITE_A_SOURCE,
  RENDER_SCREEN_SCHEMA,
  renderScreenSchema,
} from "./schema";

export { lowerSpec, type LoweringIssue, type LoweringResult } from "./lower";

export {
  groundSpec,
  type GroundingIssue,
  type GroundingResult,
  type ToolCallRecord,
} from "./grounding";
