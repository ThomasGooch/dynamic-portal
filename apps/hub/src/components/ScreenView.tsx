import type { UiNode } from "@portal/protocol";
import type { Failure } from "@portal/registry";

/**
 * A satellite that is unwell degrades to a scoped card.
 *
 * The card is deliberately specific about *which* failure it was, because
 * "something went wrong" costs an operator the first twenty minutes of an
 * incident. It is deliberately vague about the satellite's own error text,
 * because that may carry internal paths — the proxy already withheld it and
 * this must not undo that.
 */
export function ErrorCard({
  satelliteName,
  failure,
}: {
  satelliteName: string;
  failure: Failure;
}) {
  const { title, body } = explain(satelliteName, failure);
  return (
    <div className="errorCard" role="alert">
      <h2>{title}</h2>
      <p>{body}</p>
      <p>
        Other solutions are unaffected. <code>{failure.reason}</code>
      </p>
    </div>
  );
}

function explain(name: string, failure: Failure): { title: string; body: string } {
  switch (failure.reason) {
    case "unavailable":
      return {
        title: `${name} is not responding`,
        body: `It failed repeatedly, so the hub has stopped calling it for now. Retrying in about ${Math.ceil(
          failure.retryAfterMs / 1000,
        )}s.`,
      };
    case "timeout":
      return {
        title: `${name} took too long`,
        body: "The request passed its deadline and was abandoned rather than left to hang.",
      };
    case "not-found":
      return { title: "Not found", body: `${name} has no such screen or record.` };
    case "forbidden":
      return {
        title: "Not available to you",
        body: `${name} declined this request for your account.`,
      };
    case "invalid-response":
      return {
        title: `${name} sent something the portal cannot render`,
        body: "Its response did not match the published protocol, so it was rejected at the edge rather than shown as a broken page.",
      };
    case "upstream-error":
      return {
        title: `${name} reported an error`,
        body: `It answered with status ${failure.status}.`,
      };
  }
}

/**
 * A structural preview of a validated screen.
 *
 * **Temporary.** The renderer bindings replace this entirely in the next change.
 * It exists so this PR can prove the pipeline end to end — registry, proxy,
 * protocol validation, catalog validation — without also carrying the renderer,
 * which is a substantial change of its own.
 */
export function TreePreview({ ui }: { ui: UiNode }) {
  return (
    <section className="treePreview">
      <h2>Validated screen &middot; pending renderer</h2>
      <NodeList nodes={[ui]} />
    </section>
  );
}

function NodeList({ nodes }: { nodes: readonly UiNode[] }) {
  return (
    <ul>
      {nodes.map((node, index) => (
        <li key={node.id ?? `${node.type}-${index}`}>
          <span className="nodeType">{node.type}</span>
          {node.id !== undefined && <span className="nodeId"> #{node.id}</span>}
          {node.children !== undefined && node.children.length > 0 && (
            <NodeList nodes={node.children} />
          )}
        </li>
      ))}
    </ul>
  );
}
