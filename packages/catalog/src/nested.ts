import type { UiNode } from "@portal/protocol";
import { CATALOG_VERSION, propsSchemaFor } from "./components.js";

/**
 * Deep validation of the shape satellites emit.
 *
 * The protocol checks that a node is structurally a node; this checks that it
 * is a *legal component with legal props*. Keeping the two apart is what lets
 * the catalog change without a protocol release.
 *
 * The walk is iterative. A recursive walk would reintroduce the stack-overflow
 * the protocol's depth guard exists to prevent, and a validator that crashes on
 * hostile input is worse than no validator.
 */

export interface CatalogIssue {
  /** Dotted path to the offending node, e.g. `children.0.children.2`. */
  readonly path: string;
  readonly message: string;
}

export type CatalogResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly CatalogIssue[] };

export function validateNested(root: UiNode): CatalogResult {
  const issues: CatalogIssue[] = [];
  const stack: { node: UiNode; path: string }[] = [{ node: root, path: "" }];

  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    const where = path === "" ? "(root)" : path;

    const schema = propsSchemaFor(node.type);
    if (schema === undefined) {
      issues.push({
        path: where,
        message: `Unknown component "${node.type}". It is not in catalog v${CATALOG_VERSION}.`,
      });
      continue;
    }

    const parsed = schema.safeParse(node.props ?? {});
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const propPath = issue.path.length > 0 ? ` at props.${issue.path.join(".")}` : "";
        issues.push({ path: where, message: `${node.type}${propPath}: ${issue.message}` });
      }
    }

    const children = node.children ?? [];
    // Pushed in reverse so the first child is reported first despite the stack.
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child !== undefined) {
        stack.push({ node: child, path: path === "" ? `children.${i}` : `${path}.children.${i}` });
      }
    }
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
