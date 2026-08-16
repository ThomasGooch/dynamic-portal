import type { UiNode } from "@portal/protocol";
import type { FlatElement, FlatSpec } from "./flat.js";

/**
 * Conversions between the three shapes.
 *
 *   nested   satellites author it — readable, diffable, easy from any language
 *   flat     the agent emits it — a list, so it can be strict-schema-constrained
 *   keyed    json-render consumes it — a map, its native format
 *
 * These are the only code in the workspace that knows the renderer's shape. If
 * `json-render` is replaced, this file changes and nothing else does — which is
 * the containment the plan promises for a labs-stage dependency.
 *
 * Every walk here is iterative: these run at the trust boundary on
 * satellite-supplied input, and a recursive walk would be a stack overflow
 * waiting for a hostile tree.
 */

/** json-render's native spec: elements keyed by id. */
export interface KeyedSpec {
  readonly root: string;
  readonly elements: Record<string, KeyedElement>;
}

export interface KeyedElement {
  readonly type: string;
  readonly props?: Record<string, unknown> | undefined;
  readonly children?: string[] | undefined;
}

/**
 * Marks an id the adapter invented rather than one an author wrote.
 *
 * Without this the conversion is quietly lossy: a flat spec cannot say which
 * ids were synthetic, so rebuilding a nested tree either drops the author's ids
 * — breaking `ActionResponse.patch`, which addresses them — or stamps generated
 * ids onto nodes that never had one. The prefix makes the distinction survive
 * the round trip. It is rejected as author input below, so the marker cannot be
 * forged and the invariant is enforced rather than assumed.
 */
export const GENERATED_ID_PREFIX = "~";

export class ReservedNodeIdError extends Error {
  constructor(readonly id: string) {
    super(
      `Node id ${JSON.stringify(id)} is reserved: ids beginning with ` +
        `"${GENERATED_ID_PREFIX}" mark adapter-generated nodes.`,
    );
    this.name = "ReservedNodeIdError";
  }
}

/**
 * Ids are assigned breadth-first from a counter, so the same tree always yields
 * the same ids. Author-supplied ids are preserved untouched, because
 * `ActionResponse.patch` addresses them — generating over one would break
 * partial re-render.
 */
export function nestedToFlat(root: UiNode): FlatSpec {
  const taken = new Set<string>();

  // Iteratively, not recursively: this runs on satellite-supplied input, and a
  // recursive walk overflows the stack on a deep tree — the exact failure the
  // file header promises not to have.
  const pending: UiNode[] = [root];
  const collected = new Set<UiNode>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (collected.has(node)) continue;
    collected.add(node);
    if (node.id !== undefined) {
      if (node.id.startsWith(GENERATED_ID_PREFIX)) throw new ReservedNodeIdError(node.id);
      taken.add(node.id);
    }
    for (const child of node.children ?? []) pending.push(child);
  }

  let counter = 0;
  const nextId = (): string => {
    let candidate: string;
    do {
      candidate = `${GENERATED_ID_PREFIX}${counter++}`;
    } while (taken.has(candidate));
    taken.add(candidate);
    return candidate;
  };

  // Two passes: assign every id first, so a parent can name children that have
  // not been visited yet without a second reconciliation pass.
  //
  // A node object reached more than once — an author reusing one constant for
  // two slots — keeps the id it was first given and is emitted once. Assigning
  // per visit would put two elements with the same id in the list, which
  // `FlatSpecSchema` then rejects as a duplicate.
  const ids = new Map<UiNode, string>();
  const order: UiNode[] = [];
  const assign: UiNode[] = [root];
  while (assign.length > 0) {
    const node = assign.shift()!;
    if (ids.has(node)) continue;
    ids.set(node, node.id ?? nextId());
    order.push(node);
    for (const child of node.children ?? []) assign.push(child);
  }

  const elements: FlatElement[] = order.map((node) => {
    const children = node.children ?? [];
    return {
      id: ids.get(node)!,
      type: node.type,
      ...(node.props !== undefined ? { props: node.props } : {}),
      children: children.map((c) => ids.get(c)!),
    };
  });

  return { root: ids.get(root)!, elements };
}

export function flatToKeyed(spec: FlatSpec): KeyedSpec {
  // Null-prototype: element ids come from satellites and agents, and assigning
  // `elements["__proto__"] = …` on a normal object literal invokes the
  // prototype setter instead of adding a key — the element would silently
  // vanish from `Object.keys`, so the renderer would draw nothing for it.
  const elements = Object.create(null) as Record<string, KeyedElement>;
  for (const element of spec.elements) {
    elements[element.id] = {
      type: element.type,
      ...(element.props !== undefined ? { props: element.props } : {}),
      ...(element.children !== undefined ? { children: element.children } : {}),
    };
  }
  return { root: spec.root, elements };
}

export function nestedToKeyed(root: UiNode): KeyedSpec {
  return flatToKeyed(nestedToFlat(root));
}

/**
 * Rebuilds a nested tree. Used by the hub to apply an `ActionResponse.patch`
 * against a spec it is already holding, and by tests to prove the conversions
 * lose nothing.
 *
 * Assumes the spec has been validated — `FlatSpecSchema` rejects dangling
 * references and cycles, so this can walk without re-checking them.
 */
export function keyedToNested(spec: KeyedSpec): UiNode {
  // `hasOwnProperty`, not a truthiness test: `spec.elements["constructor"]`
  // resolves up the prototype chain on a plain object and would sail past an
  // `=== undefined` guard, yielding a node with no `type`.
  const lookup = (id: string): KeyedElement => {
    const element = Object.prototype.hasOwnProperty.call(spec.elements, id)
      ? spec.elements[id]
      : undefined;
    if (element === undefined) throw new Error(`element "${id}" not found`);
    return element;
  };

  // Iterative post-order. `FlatSpecSchema` deliberately permits trees far
  // deeper than the protocol's nested bound, so recursion here would overflow
  // on a spec this package itself calls valid.
  const built = new Map<string, UiNode>();
  const entered = new Set<string>();
  const stack: { id: string; phase: "enter" | "exit" }[] = [
    { id: spec.root, phase: "enter" },
  ];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const element = lookup(frame.id);

    if (frame.phase === "enter") {
      if (built.has(frame.id)) continue;
      if (entered.has(frame.id)) throw new Error(`cycle detected at element "${frame.id}"`);
      entered.add(frame.id);
      stack.push({ id: frame.id, phase: "exit" });
      for (const childId of element.children ?? []) stack.push({ id: childId, phase: "enter" });
      continue;
    }

    const children = (element.children ?? []).map((childId) => built.get(childId)!);
    // Generated ids are an artifact of flattening and are dropped; author ids
    // are restored, because that is what a patch will address.
    const authored = !frame.id.startsWith(GENERATED_ID_PREFIX);
    built.set(frame.id, {
      type: element.type,
      ...(authored ? { id: frame.id } : {}),
      ...(element.props !== undefined ? { props: element.props } : {}),
      ...(children.length > 0 ? { children } : {}),
    });
  }

  return built.get(spec.root)!;
}
