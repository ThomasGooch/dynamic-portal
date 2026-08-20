import { Fragment } from "react";
import { parseMarkdown, type Block, type Inline } from "@/lib/markdown";

/**
 * The assistant's prose, as elements rather than as characters.
 *
 * Every tag this can emit is written literally below. There is no mapping from
 * a parsed name to a tag, no `createElement` with a computed type and no
 * `dangerouslySetInnerHTML` — so the set of things that can appear on screen is
 * the set of things in this file, and reading it is the whole audit.
 *
 * That is deliberate rather than decorative. The text is a model's, shaped by
 * tool results, which come from satellites; the panel draws it inside the hub's
 * own chrome. The parser has no node that carries markup, and this has no way
 * to render one if it did.
 */

function Inlines({ inlines }: { inlines: readonly Inline[] }) {
  return (
    <>
      {inlines.map((inline, at) => {
        // Keyed by position: the same word can legitimately appear twice in one
        // sentence, so the text is not an identity.
        const key = `${at}-${inline.type}`;
        if (inline.type === "bold") return <strong key={key}>{inline.text}</strong>;
        if (inline.type === "italic") return <em key={key}>{inline.text}</em>;
        if (inline.type === "code") return <code key={key}>{inline.text}</code>;
        return <Fragment key={key}>{inline.text}</Fragment>;
      })}
    </>
  );
}

function Blocks({ blocks }: { blocks: readonly Block[] }) {
  return (
    <>
      {blocks.map((block, at) => {
        const key = `${at}-${block.type}`;

        if (block.type === "code") {
          return (
            <pre key={key} className="agentCode">
              <code>{block.text}</code>
            </pre>
          );
        }

        if (block.type === "list") {
          const items = block.items.map((item, index) => (
            <li key={`${index}-item`}>
              <Inlines inlines={item} />
            </li>
          ));
          // Both spelled out rather than one element with a computed tag, so
          // the tags in this file are the tags that can reach a browser.
          return block.ordered ? (
            <ol key={key} className="agentList">
              {items}
            </ol>
          ) : (
            <ul key={key} className="agentList">
              {items}
            </ul>
          );
        }

        if (block.type === "heading") {
          // The panel is a column a few hundred pixels wide, so these are sized
          // by the stylesheet rather than by which tag they landed on — but the
          // tag still carries the level for anything reading the document.
          if (block.level === 1) {
            return (
              <h3 key={key} className="agentHeading" data-level="1">
                <Inlines inlines={block.inlines} />
              </h3>
            );
          }
          if (block.level === 2) {
            return (
              <h4 key={key} className="agentHeading" data-level="2">
                <Inlines inlines={block.inlines} />
              </h4>
            );
          }
          return (
            <h5 key={key} className="agentHeading" data-level="3">
              <Inlines inlines={block.inlines} />
            </h5>
          );
        }

        return (
          <p key={key} className="agentText">
            <Inlines inlines={block.inlines} />
          </p>
        );
      })}
    </>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);

  // An answer that is only whitespace still needs somewhere to be, or the turn
  // renders as nothing at all and reads as a failure.
  if (blocks.length === 0) return <p className="agentText">{text}</p>;

  return <div className="agentProse">{<Blocks blocks={blocks} />}</div>;
}
