import { MAX_NODE_DEPTH, type UiNode } from "@portal/protocol";
import { describe, expect, it } from "vitest";
import { applyPatches } from "./patch";

const leaf = (id: string, text = id): UiNode => ({
  type: "Text",
  id,
  props: { text },
});

const screen: UiNode = {
  type: "Page",
  id: "page",
  children: [
    { type: "Section", id: "left", children: [leaf("a"), leaf("b")] },
    { type: "Section", id: "right", children: [leaf("c")] },
  ],
};

/** A chain of `depth` nested Sections ending in a Text. */
function chain(depth: number, leafId = "tip"): UiNode {
  let node: UiNode = leaf(leafId);
  for (let i = 0; i < depth - 1; i += 1) node = { type: "Section", children: [node] };
  return node;
}

function depthOf(root: UiNode): number {
  let max = 0;
  const stack: { node: UiNode; depth: number }[] = [{ node: root, depth: 1 }];
  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    if (entry.depth > max) max = entry.depth;
    for (const child of entry.node.children ?? []) {
      stack.push({ node: child, depth: entry.depth + 1 });
    }
  }
  return max;
}

describe("applyPatches", () => {
  it("replaces the addressed subtree and leaves its siblings alone", () => {
    const result = applyPatches(screen, [{ targetId: "b", ui: leaf("b", "replaced") }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const left = result.ui.children?.[0];
    expect(left?.children?.[0]).toEqual(leaf("a"));
    expect(left?.children?.[1]?.props?.["text"]).toBe("replaced");
    expect(result.ui.children?.[1]).toEqual(screen.children?.[1]);
  });

  it("does not mutate the tree it was given", () => {
    const before = JSON.parse(JSON.stringify(screen)) as UiNode;
    applyPatches(screen, [{ targetId: "b", ui: leaf("b", "replaced") }]);
    expect(screen).toEqual(before);
  });

  it("can replace the root", () => {
    const result = applyPatches(screen, [{ targetId: "page", ui: leaf("page", "gone") }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ui.type).toBe("Text");
  });

  it("applies several patches in order", () => {
    const result = applyPatches(screen, [
      { targetId: "a", ui: leaf("a", "one") },
      { targetId: "c", ui: leaf("c", "two") },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ui.children?.[0]?.children?.[0]?.props?.["text"]).toBe("one");
    expect(result.ui.children?.[1]?.children?.[0]?.props?.["text"]).toBe("two");
  });

  it("rejects a patch addressing a node that is not on the screen", () => {
    // Silently dropping it would show a success toast next to stale data — the
    // satellite believes it updated something the user never saw change.
    const result = applyPatches(screen, [{ targetId: "nope", ui: leaf("nope") }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/nope/);
  });

  it("rejects a patch whose subtree reuses an id already on the screen", () => {
    // Two nodes sharing an id makes the *next* patch ambiguous. The protocol
    // rejects duplicates within one tree; splicing is the other way to make one.
    const result = applyPatches(screen, [
      { targetId: "b", ui: { type: "Section", id: "b", children: [leaf("c")] } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/"c"/);
  });

  it("allows a patch to reuse ids from the subtree it replaces", () => {
    // `left` is being replaced, so its children's ids leave with it. A rule
    // that compared against the pre-patch tree would reject this re-render of
    // the same section, which is the single most common patch there is.
    const result = applyPatches(screen, [
      { targetId: "left", ui: { type: "Section", id: "left", children: [leaf("a"), leaf("b")] } },
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects a splice that nests deeper than a satellite could have served", () => {
    // Each half is individually within the wire limit, so neither was rejected
    // on arrival. Nesting compounds: without this the depth bound erodes one
    // patch at a time until the renderer meets a tree no validator ever saw.
    const deep = chain(MAX_NODE_DEPTH);
    expect(depthOf(deep)).toBe(MAX_NODE_DEPTH);

    const result = applyPatches(deep, [{ targetId: "tip", ui: chain(MAX_NODE_DEPTH) }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(new RegExp(String(MAX_NODE_DEPTH)));
  });

  it("accepts a splice that lands exactly on the limit", () => {
    const host = chain(MAX_NODE_DEPTH - 2);
    const result = applyPatches(host, [{ targetId: "tip", ui: chain(3) }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(depthOf(result.ui)).toBe(MAX_NODE_DEPTH);
  });

  it("returns the original tree unchanged when there are no patches", () => {
    const result = applyPatches(screen, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ui).toEqual(screen);
  });

  it("leaves the screen untouched when one patch in a batch is bad", () => {
    // All or nothing: a half-applied batch is a screen the satellite never
    // described, and the user has no way to tell which half landed.
    const result = applyPatches(screen, [
      { targetId: "a", ui: leaf("a", "one") },
      { targetId: "nope", ui: leaf("nope") },
    ]);
    expect(result.ok).toBe(false);
  });
});
