/**
 * A deliberately small markdown, for the one place the portal shows prose.
 *
 * The assistant writes markdown whether or not it was asked to, so the panel
 * was showing readers `**Order List**` and asking them to imagine the bold.
 * This reads it. What it will *not* do is the reason it is hand-written rather
 * than a dependency:
 *
 * **There is no HTML anywhere in this file.** Not escaped, not sanitised, not
 * parsed and rejected — simply absent. The output is a list of typed nodes with
 * no field that could carry markup, and the component that renders them builds
 * React elements from a fixed set of tags. That matters because of where the
 * text comes from: a model, shaped by tool results, which come from satellites.
 * This repository's trust boundary is that a compromised satellite cannot
 * inject markup, scripts or styling into the shell, and a markdown pipeline
 * with an HTML passthrough — every general one has a switch for it — is exactly
 * how that boundary gets reopened by a later well-meaning commit.
 *
 * The subset is what a model actually writes when answering a question:
 * paragraphs, bullets, numbered lists, three levels of heading, fenced code,
 * bold, italic and inline code. Anything else survives as the characters it is,
 * which is a worse-looking answer and never a dangerous one.
 *
 * **Nested lists are flattened to one level, knowingly.** A model answering
 * "what can this do" indents sub-points under a bold label, and those arrive
 * here as siblings. It reads acceptably — the bold still groups them — and the
 * alternative is a tree walker with an indent stack, which is where hand-written
 * markdown parsers earn their reputation. In a file whose whole value is that it
 * is short enough to audit in one sitting, that is a bad trade. If nesting is
 * ever wanted, it is a change to `parseMarkdown` alone: the node types and the
 * renderer already have no opinion about depth.
 *
 * **Links are rendered as their label.** An anchor the model wrote, drawn
 * inside the portal's own chrome, would carry the hub's authority to a
 * destination taken from text a satellite can influence. The catalog's `Link`
 * is allowlisted to registered satellites for that reason; nothing here has
 * that allowlist, so nothing here gets an anchor.
 */

export type Inline =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "bold"; readonly text: string }
  | { readonly type: "italic"; readonly text: string }
  | { readonly type: "code"; readonly text: string };

export type Block =
  | { readonly type: "paragraph"; readonly inlines: readonly Inline[] }
  | { readonly type: "heading"; readonly level: 1 | 2 | 3; readonly inlines: readonly Inline[] }
  | { readonly type: "list"; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[] }
  | { readonly type: "code"; readonly text: string };

const BULLET = /^\s{0,3}[-*]\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const FENCE = /^\s*```/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;

  const closeParagraph = (): void => {
    if (paragraph.length === 0) return;
    // Soft wrapping is a line break in the source and a space on screen, which
    // is what a model means by it.
    blocks.push({ type: "paragraph", inlines: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };

  const closeList = (): void => {
    if (list === undefined) return;
    blocks.push({
      type: "list",
      ordered: list.ordered,
      items: list.items.map(parseInline),
    });
    list = undefined;
  };

  const closeAll = (): void => {
    closeParagraph();
    closeList();
  };

  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? "";

    if (FENCE.test(line)) {
      closeAll();
      const body: string[] = [];
      at += 1;
      // Consumed verbatim: a model quoting a tool result wants it shown, not
      // interpreted. An unterminated fence ends at the end of the text rather
      // than swallowing the panel.
      while (at < lines.length && !FENCE.test(lines[at] ?? "")) {
        body.push(lines[at] ?? "");
        at += 1;
      }
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      closeAll();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      closeAll();
      blocks.push({
        type: "heading",
        level: heading[1]!.length as 1 | 2 | 3,
        inlines: parseInline(heading[2]!),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet !== null || numbered !== null) {
      const ordered = numbered !== null;
      closeParagraph();
      // A change of list kind starts a new list rather than mixing the two.
      if (list !== undefined && list.ordered !== ordered) closeList();
      list ??= { ordered, items: [] };
      list.items.push((ordered ? numbered![1] : bullet![1])!);
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  closeAll();
  return blocks;
}

/**
 * Link and image syntax, reduced to the text a reader was meant to see.
 *
 * Done before the emphasis pass so a label can still be bold, and done with the
 * destination discarded rather than kept for later — there is nowhere in the
 * output to put a URL, which is the point.
 */
const stripTargets = (text: string): string =>
  // One level of nesting allowed in the destination, because `alert(1)` and
  // `…/Foo_(bar)` both contain a bracket and a matcher that stopped at the
  // first one left the stray `)` in the reader's text. Cosmetic rather than
  // dangerous — no anchor is produced either way — but the label is the only
  // thing that survives, so it should be the label.
  text.replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1");

/** In precedence order: code first (it suppresses everything), then bold, then italic. */
const MARKERS: readonly { readonly pattern: RegExp; readonly type: Inline["type"] }[] = [
  { pattern: /`([^`]+)`/, type: "code" },
  { pattern: /\*\*([^*]+)\*\*/, type: "bold" },
  { pattern: /(?<!\*)\*([^*]+)\*(?!\*)/, type: "italic" },
  { pattern: /_([^_]+)_/, type: "italic" },
];

export function parseInline(source: string): Inline[] {
  const text = stripTargets(source);
  const inlines: Inline[] = [];
  let rest = text;

  while (rest !== "") {
    // The earliest marker of any kind wins, so `a **b** c` and `a *b* c` both
    // split where a reader expects rather than where the list happens to order.
    let best: { at: number; length: number; inner: string; type: Inline["type"] } | undefined;

    for (const { pattern, type } of MARKERS) {
      const found = pattern.exec(rest);
      if (found === null) continue;
      const at = found.index;
      if (best === undefined || at < best.at) {
        best = { at, length: found[0].length, inner: found[1]!, type };
      }
    }

    if (best === undefined) {
      inlines.push({ type: "text", text: rest });
      break;
    }

    if (best.at > 0) inlines.push({ type: "text", text: rest.slice(0, best.at) });
    inlines.push({ type: best.type, text: best.inner });
    rest = rest.slice(best.at + best.length);
  }

  // An unclosed marker leaves no match at all, so it arrives here as the
  // character it is — `2 * 3` stays arithmetic.
  return inlines.filter((inline) => inline.text !== "");
}
