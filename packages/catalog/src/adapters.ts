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
  const elements: FlatElement[] = [];
  const taken = new Set<string>();

  const collect = (node: UiNode): void => {
    if (node.id !== undefined) {
      if (node.id.startsWith(GENERATED_ID_PREFIX)) throw new ReservedNodeIdError(node.id);
      taken.add(node.id);
    }
    for (const child of node.children ?? []) collect(child);
  };
  collect(root);

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
  const ids = new Map<UiNode, string>();
  const assign: UiNode[] = [root];
  while (assign.length > 0) {
    const node = assign.shift()!;
    ids.set(node, node.id ?? nextId());
    for (const child of node.children ?? []) assign.push(child);
  }

  const queue: UiNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    const children = node.children ?? [];
    elements.push({
      id: ids.get(node)!,
      type: node.type,
      ...(node.props !== undefined ? { props: node.props } : {}),
      children: children.map((c) => ids.get(c)!),
    });
    for (const child of children) queue.push(child);
  }

  return { root: ids.get(root)!, elements };
}

export function flatToKeyed(spec: FlatSpec): KeyedSpec {
  const elements: Record<string, KeyedElement> = {};
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
  const build = (id: string): UiNode => {
    const element = spec.elements[id];
    if (element === undefined) throw new Error(`element "${id}" not found`);
    const children = (element.children ?? []).map(build);
    // Generated ids are an artifact of flattening and are dropped; author ids
    // are restored, because that is what a patch will address.
    const authored = !id.startsWith(GENERATED_ID_PREFIX);
    return {
      type: element.type,
      ...(authored ? { id } : {}),
      ...(element.props !== undefined ? { props: element.props } : {}),
      ...(children.length > 0 ? { children } : {}),
    };
  };
  return build(spec.root);
}
