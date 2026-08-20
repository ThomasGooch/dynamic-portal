import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown";

/**
 * The assistant writes markdown whether or not anyone asked it to.
 *
 * Before this, `**Order List**` reached the panel as those exact characters —
 * the model formatting an answer and the portal showing its working. So the
 * question was never whether to parse it, only how much, and the answer is
 * governed by where the text comes from: a model, shaped by tool results, which
 * come from satellites. The trust boundary this repository claims is that a
 * satellite cannot inject markup into the shell. **So there is no HTML path
 * here at all** — not escaped, not sanitised, not present. Every case below
 * that looks like markup is asserted to survive as text.
 */

const text = (value: string) => ({ type: "text" as const, text: value });

describe("blocks", () => {
  it("splits paragraphs on blank lines", () => {
    expect(parseMarkdown("one\n\ntwo")).toEqual([
      { type: "paragraph", inlines: [text("one")] },
      { type: "paragraph", inlines: [text("two")] },
    ]);
  });

  it("keeps a soft-wrapped paragraph as one paragraph", () => {
    expect(parseMarkdown("one\ntwo")).toEqual([
      { type: "paragraph", inlines: [text("one two")] },
    ]);
  });

  it("reads a bulleted list", () => {
    const blocks = parseMarkdown("- first\n- second");
    expect(blocks).toEqual([
      { type: "list", ordered: false, items: [[text("first")], [text("second")]] },
    ]);
  });

  it("accepts either bullet character", () => {
    expect(parseMarkdown("* only")).toEqual([
      { type: "list", ordered: false, items: [[text("only")]] },
    ]);
  });

  it("reads a numbered list, and does not renumber it", () => {
    const blocks = parseMarkdown("1. first\n2. second");
    expect(blocks).toEqual([
      { type: "list", ordered: true, items: [[text("first")], [text("second")]] },
    ]);
  });

  it("reads headings up to three levels", () => {
    expect(parseMarkdown("# a\n\n## b\n\n### c")).toEqual([
      { type: "heading", level: 1, inlines: [text("a")] },
      { type: "heading", level: 2, inlines: [text("b")] },
      { type: "heading", level: 3, inlines: [text("c")] },
    ]);
  });

  it("treats a deeper heading as text, since the panel has no room for one", () => {
    expect(parseMarkdown("#### d")).toEqual([
      { type: "paragraph", inlines: [text("#### d")] },
    ]);
  });

  it("keeps a fenced block verbatim, including its blank lines", () => {
    expect(parseMarkdown("```\n{\n\n}\n```")).toEqual([{ type: "code", text: "{\n\n}" }]);
  });

  it("does not read markdown inside a fence", () => {
    // A model quoting a tool result should see it rendered, not interpreted.
    expect(parseMarkdown("```\n**not bold**\n```")).toEqual([
      { type: "code", text: "**not bold**" },
    ]);
  });

  it("closes an unterminated fence at the end of the text", () => {
    // A truncated answer must not swallow the rest of the panel.
    expect(parseMarkdown("```\nstill code")).toEqual([{ type: "code", text: "still code" }]);
  });

  it("ignores trailing whitespace rather than emitting an empty paragraph", () => {
    expect(parseMarkdown("one\n\n\n\n")).toEqual([
      { type: "paragraph", inlines: [text("one")] },
    ]);
  });

  it("returns nothing for nothing", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n  ")).toEqual([]);
  });
});

describe("inline", () => {
  it("reads bold", () => {
    expect(parseMarkdown("a **b** c")[0]).toEqual({
      type: "paragraph",
      inlines: [text("a "), { type: "bold", text: "b" }, text(" c")],
    });
  });

  it("reads italic in both spellings", () => {
    expect(parseMarkdown("*a* and _b_")[0]).toEqual({
      type: "paragraph",
      inlines: [
        { type: "italic", text: "a" },
        text(" and "),
        { type: "italic", text: "b" },
      ],
    });
  });

  /**
   * A model answering a question about this portal writes `summary_screen_id`
   * and `health_path` in prose, not only in backticks. Without word boundaries
   * the second underscore pair closed an emphasis span, the underscores
   * vanished and one syllable came out italic — a field name silently rewritten
   * in the middle of an answer about field names.
   */
  it("leaves snake_case alone", () => {
    expect(parseMarkdown("set summary_screen_id on it")[0]).toEqual({
      type: "paragraph",
      inlines: [text("set summary_screen_id on it")],
    });
  });

  it("reads inline code", () => {
    expect(parseMarkdown("call `orders.search` now")[0]).toEqual({
      type: "paragraph",
      inlines: [text("call "), { type: "code", text: "orders.search" }, text(" now")],
    });
  });

  it("does not read markdown inside inline code", () => {
    expect(parseMarkdown("`**x**`")[0]).toEqual({
      type: "paragraph",
      inlines: [{ type: "code", text: "**x**" }],
    });
  });

  it("prefers bold over italic where both could match", () => {
    expect(parseMarkdown("**b**")[0]).toEqual({
      type: "paragraph",
      inlines: [{ type: "bold", text: "b" }],
    });
  });

  it("leaves an unclosed marker as the character it is", () => {
    // `2 * 3 * 4` does read as emphasis by markdown's rules, and that is the
    // honest limit of a subset this size: it is wrong-looking, never unsafe.
    expect(parseMarkdown("2 * 3 * 4")[0]).toEqual({
      type: "paragraph",
      inlines: [text("2 "), { type: "italic", text: " 3 " }, text(" 4")],
    });
    expect(parseMarkdown("a ** b")[0]).toEqual({
      type: "paragraph",
      inlines: [text("a ** b")],
    });
  });

  it("flattens a nested list to one level, which is the documented limit", () => {
    // Asserted rather than left to chance. A model writing "what can this do"
    // indents sub-points under a bold label; they arrive as siblings and the
    // bold still groups them. Recorded here so the day someone wants real
    // nesting, the change is visible as a change.
    expect(parseMarkdown("- **Creating**\n  - place an order\n  - example")).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          [{ type: "bold", text: "Creating" }],
          [text("place an order")],
          [text("example")],
        ],
      },
    ]);
  });

  it("reads inline markers inside a list item", () => {
    expect(parseMarkdown("- **Order List**: view orders")[0]).toEqual({
      type: "list",
      ordered: false,
      items: [[{ type: "bold", text: "Order List" }, text(": view orders")]],
    });
  });
});

/**
 * The half that matters. Every one of these is text a satellite could put on a
 * screen, that the agent could quote into an answer, that would render inside
 * the hub's own trusted chrome.
 */
describe("markup never becomes markup", () => {
  const hostile = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<iframe src='https://example.test'></iframe>",
    "<a href='javascript:alert(1)'>click</a>",
    "<style>body{display:none}</style>",
    "<div onclick='steal()'>hi</div>",
  ];

  for (const source of hostile) {
    it(`keeps ${source.slice(0, 24)}… as text`, () => {
      const blocks = parseMarkdown(source);

      // One paragraph, one text run, byte for byte what arrived. The parser has
      // no node type that could carry markup even if it wanted to.
      expect(blocks).toEqual([{ type: "paragraph", inlines: [text(source)] }]);
    });
  }

  it("renders a link as its label and never as a link", () => {
    // Deliberate. An anchor the model wrote, drawn inside the portal's own
    // chrome, is a phishing surface wearing the hub's authority — and the href
    // would come from text a satellite can influence. The catalog's `Link` is
    // allowlisted to registered satellites for the same reason; nothing here
    // has that allowlist, so nothing here gets an anchor.
    expect(parseMarkdown("see [the docs](https://example.test/x)")[0]).toEqual({
      type: "paragraph",
      inlines: [text("see the docs")],
    });
  });

  it("drops a javascript: link to its label too", () => {
    expect(parseMarkdown("[click](javascript:alert(1))")[0]).toEqual({
      type: "paragraph",
      inlines: [text("click")],
    });
  });

  it("keeps an image as its alt text, not an element", () => {
    expect(parseMarkdown("![a cat](https://example.test/c.png)")[0]).toEqual({
      type: "paragraph",
      inlines: [text("a cat")],
    });
  });
});
