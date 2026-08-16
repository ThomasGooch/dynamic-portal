import { MAX_NODE_DEPTH, type UiNode } from "@portal/protocol";

/**
 * Splicing a satellite's `patch` into the screen already on the user's display.
 *
 * This is the half of the `ActionResponse` envelope that makes forms work with
 * no satellite JavaScript: the satellite says *what should now be true* about
 * one addressed subtree, and the hub rebuilds the screen around it.
 *
 * Two invariants have to survive the splice, and neither survives on its own.
 *
 * **Depth.** Both trees arrived within `MAX_NODE_DEPTH`, so neither was
 * rejected on the wire — but nesting compounds. A screen at depth 60 patched
 * with a subtree of depth 60 is a screen of depth 119 that no validator ever
 * saw, and repeating it walks the renderer off the end of the stack one action
 * at a time. The result is held to the same bound the wire is, so the hub never
 * renders a tree the satellite could not have served directly.
 *
 * **Unique ids.** `targetId` is how a patch addresses a node, so two nodes
 * sharing an id makes the *next* patch ambiguous. The protocol rejects
 * duplicates within a single tree; splicing is the other way to make one.
 */

export interface Patch {
  readonly targetId: string;
  readonly ui: UiNode;
}

export type PatchResult =
  | { readonly ok: true; readonly ui: UiNode }
  | { readonly ok: false; readonly reason: string };

/**
 * Applies patches in order, all or nothing.
 *
 * A half-applied batch is a screen the satellite never described, and nothing
 * on it tells the user which half landed. Each step builds a new tree rather
 * than editing one, so a failure anywhere leaves the caller's tree untouched
 * with no rollback to get wrong.
 */
export function applyPatches(root: UiNode, patches: readonly Patch[]): PatchResult {
  let current = root;

  for (const patch of patches) {
    const path = findPath(current, patch.targetId);
    if (path === undefined) {
      // Dropping it silently would pair a success toast with stale data: the
      // satellite believes it updated something the user never saw change.
      return {
        ok: false,
        reason: `patch addresses "${patch.targetId}", which is not on this screen`,
      };
    }

    // `path.length` is the number of edges above the target, so this is the
    // depth the deepest node of the incoming subtree would end up at.
    const depth = path.length + treeDepth(patch.ui);
    if (depth > MAX_NODE_DEPTH) {
      return {
        ok: false,
        reason: `patch would nest ${depth} levels deep, past the ${MAX_NODE_DEPTH}-level limit`,
      };
    }

    const replaced = collectIds(subtreeAt(current, path));
    const surviving = collectIds(current);
    for (const id of replaced) surviving.delete(id);

    const incoming = new Set<string>();
    for (const id of collectIds(patch.ui)) {
      if (surviving.has(id) || incoming.has(id)) {
        return {
          ok: false,
          reason: `patch introduces id "${id}", which is already on this screen`,
        };
      }
      incoming.add(id);
    }

    current = replaceAt(current, path, patch.ui);
  }

  return { ok: true, ui: current };
}

/** Child indices from the root down to the node with this id, or undefined. */
function findPath(root: UiNode, id: string): number[] | undefined {
  const stack: { node: UiNode; path: number[] }[] = [{ node: root, path: [] }];

  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    if (entry.node.id === id) return entry.path;
    const children = entry.node.children ?? [];
    for (let i = 0; i < children.length; i += 1) {
      stack.push({ node: children[i] as UiNode, path: [...entry.path, i] });
    }
  }

  return undefined;
}

function subtreeAt(root: UiNode, path: readonly number[]): UiNode {
  let node = root;
  for (const index of path) node = node.children?.[index] as UiNode;
  return node;
}

/**
 * Rebuilds the spine from the target back up to the root, sharing every
 * untouched subtree by reference. The caller's tree is never written to, which
 * is what lets React see a changed screen as a changed object.
 */
function replaceAt(root: UiNode, path: readonly number[], next: UiNode): UiNode {
  if (path.length === 0) return next;

  const spine: UiNode[] = [root];
  let node = root;
  for (const index of path) {
    node = node.children?.[index] as UiNode;
    spine.push(node);
  }

  let rebuilt = next;
  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const parent = spine[depth] as UiNode;
    const children = [...(parent.children ?? [])];
    children[path[depth] as number] = rebuilt;
    rebuilt = { ...parent, children };
  }
  return rebuilt;
}

function treeDepth(root: UiNode): number {
  let deepest = 0;
  const stack: { node: UiNode; depth: number }[] = [{ node: root, depth: 1 }];

  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    if (entry.depth > deepest) deepest = entry.depth;
    for (const child of entry.node.children ?? []) {
      stack.push({ node: child, depth: entry.depth + 1 });
    }
  }
  return deepest;
}

function collectIds(root: UiNode): Set<string> {
  const ids = new Set<string>();
  const stack: UiNode[] = [root];

  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.id !== undefined) ids.add(node.id);
    for (const child of node.children ?? []) stack.push(child);
  }
  return ids;
}
