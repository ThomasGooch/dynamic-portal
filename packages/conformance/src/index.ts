/**
 * The conformance kit.
 *
 * A satellite team runs this against their own service and learns, in a minute,
 * whether the hub will accept it — instead of learning from the hub failing in
 * an environment they cannot see. PLAN.md lists it beside the SDK as adoption
 * ergonomics, because that is what it is: the marginal cost of solution twenty
 * has to equal the marginal cost of solution three.
 */

export {
  runConformance,
  type CheckResult,
  type CheckStatus,
  type ConformanceOptions,
  type ConformanceReport,
} from "./checks";
