import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The rule the markdown renderer exists under, asserted against the source.
 *
 * In the integration tier because it reads files.
 *
 * `markdown.test.ts` proves the *parser* never produces a node carrying markup.
 * This is the other half: that the *renderer* has no way to turn a node into
 * markup even if one arrived. Together they are the claim — a model's prose,
 * shaped by tool results that come from satellites, drawn inside the hub's own
 * chrome, cannot become an element the hub did not write.
 *
 * A test on source text is a blunt instrument and is used deliberately. The
 * failure it guards against is not a bug in today's code; it is a reasonable
 * commit six months from now that adds "just enough" HTML support to render one
 * awkward answer, and that reviews well in isolation.
 */

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    // Comments stripped: both files discuss `dangerouslySetInnerHTML` at length
    // in order to explain why it is absent, and matching that would make this
    // fail on exactly the code it is meant to protect.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const RENDERER = read("./Markdown.tsx");
const PARSER = read("../lib/markdown.ts");

describe("the markdown renderer", () => {
  it("has no way to inject HTML", () => {
    for (const [name, source] of [
      ["Markdown.tsx", RENDERER],
      ["lib/markdown.ts", PARSER],
    ] as const) {
      expect(source, `${name} must not set inner HTML`).not.toMatch(/dangerouslySetInnerHTML/);
      expect(source, `${name} must not build elements from a computed tag`).not.toMatch(
        /createElement\s*\(/,
      );
    }
  });

  it("emits only tags written literally in the file", () => {
    // Every JSX tag the renderer opens, as it appears in the source.
    const tags = new Set([...RENDERER.matchAll(/<([a-z][a-z0-9]*)[\s/>]/g)].map((m) => m[1]!));

    // The full vocabulary of the assistant's prose. Adding to it should mean
    // adding to this list, in a diff someone reads.
    expect([...tags].sort()).toEqual([
      "code",
      "div",
      "em",
      "h3",
      "h4",
      "h5",
      "li",
      "ol",
      "p",
      "pre",
      "strong",
      "ul",
    ]);
  });

  it("never renders an anchor, an image, or an embed", () => {
    // The parser reduces links and images to their label, so these should not
    // appear — but the renderer is where it would actually matter, and an
    // anchor is the one a later change is most likely to reach for.
    for (const tag of ["a", "img", "iframe", "object", "embed", "script", "style", "form"]) {
      expect(RENDERER, `renderer must not emit <${tag}>`).not.toMatch(
        new RegExp(`<${tag}[\\s/>]`),
      );
    }
  });

  it("is the only thing the panel renders an answer through", () => {
    const panel = read("./AgentPanel.tsx");

    // If a second path to drawing `result.text` appears, the guarantees above
    // stop covering the panel and nothing else would notice.
    expect(panel).toMatch(/<Markdown text=\{result\.text\}/);
    expect(panel).not.toMatch(/\{result\.text\}(?!\s*\/>)/);
  });
});
