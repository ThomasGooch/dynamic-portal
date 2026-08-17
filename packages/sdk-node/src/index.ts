/**
 * Typed builders for satellite authors.
 *
 * The other half of adoption. `@portal/conformance` tells a team what is wrong
 * with their service; this stops it being wrong — a mistyped prop does not
 * compile, and one the compiler cannot see throws where it was written rather
 * than at the hub's edge, three systems away.
 *
 * Deliberately builders and nothing else. There is no server, no router and no
 * framework here: a satellite is an ordinary HTTP service in whatever stack its
 * team already runs, and the moment this package has an opinion about that it
 * stops being adoptable by the teams that most need it.
 */

export {
  InvalidNodeError,
  ui,
  withId,
  withSource,
  type Builder,
  type PropsOf,
} from "./ui";

export {
  InvalidEnvelopeError,
  failed,
  invalid,
  manifest,
  ok,
  screen,
  type ManifestInput,
  type OkInput,
  type ScreenInput,
} from "./envelopes";
