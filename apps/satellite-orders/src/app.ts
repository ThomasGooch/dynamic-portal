import express, { type Express, type NextFunction, type Request, type Response } from "express";
import {
  CURRENT_PROTOCOL_VERSION,
  type ActionResponse,
  type Audience,
} from "@portal/protocol";
import {
  InvalidPrincipalError,
  authorize,
  verifyPrincipal,
  type Principal,
} from "@portal/identity";
import type { Manifest } from "@portal/protocol";
import type { OrderRepository } from "./repository";
import { detailScreen, listScreen, manifest, ordersTable } from "./screens";

export interface AppOptions {
  repository: OrderRepository;
  principalSecret: string;
  /**
   * Overridable so tests can exercise a *widened* satellite. While the
   * satellite and its screens both declare `["internal"]`, a satellite-level
   * audience check is indistinguishable from a per-screen one — the difference
   * only appears once the satellite is exposed externally. Injecting the
   * declaration follows the same reasoning as injecting the repository.
   */
  manifest?: Manifest;
}

/**
 * A request that has been through `authenticate`.
 *
 * Deliberately a local interface rather than a `declare module` augmentation:
 * `@types/express` re-exports its `Request` from `express-serve-static-core`,
 * which pnpm's strict node_modules does not expose to this package, so the
 * augmentation silently fails to compile. Because `principal` is optional, a
 * handler typed on `AuthedRequest` is still assignable to `RequestHandler`.
 */
interface AuthedRequest extends Request {
  principal?: Principal | undefined;
}

/**
 * The satellite's HTTP surface: three PUP endpoints plus health.
 *
 * Exported as a factory rather than a module-level singleton so tests can bind
 * an ephemeral port and inject a fresh repository — the reason the integration
 * suite can run without a docker-compose dependency.
 */
export function createApp({
  repository,
  principalSecret,
  manifest: declaredManifest,
}: AppOptions): Express {
  const app = express();
  app.use(express.json());
  app.disable("x-powered-by");

  /** Establishes the principal. The manifest is public; everything else is not. */
  function authenticate(req: AuthedRequest, res: Response, next: NextFunction): void {
    const header = req.header("authorization") ?? "";
    // RFC 7235: the auth-scheme is case-insensitive, so `bearer <token>` is a
    // legal request and must not be read as "no credentials at all".
    const token = /^bearer /i.test(header) ? header.slice("Bearer ".length) : "";
    if (token === "") {
      res.status(401).json({ error: "missing bearer token" });
      return;
    }
    try {
      req.principal = verifyPrincipal(token, principalSecret);
      next();
    } catch (error) {
      if (error instanceof InvalidPrincipalError) {
        res.status(401).json({ error: error.message });
        return;
      }
      next(error);
    }
  }

  /**
   * Default-deny audience and scope, enforced by the satellite rather than
   * assumed of the hub. This satellite declares itself internal-only; a
   * principal minted for a different audience must not reach tenant data even
   * with a valid signature.
   *
   * The *decision* comes from `@portal/identity` so both satellites answer
   * identically; the *enforcement* stays here, because that is what keeps a hub
   * bug from becoming a cross-tenant disclosure.
   */
  const declared = declaredManifest ?? manifest();

  /**
   * The audience actually in force for a resource.
   *
   * The protocol permits a screen or action to declare a *narrower* audience
   * than its satellite — `ManifestSchema` validates subset, not equality. So
   * checking only the satellite's audience is correct exactly while the two are
   * identical, and becomes a disclosure the moment this satellite widens to
   * `["internal", "external"]`: every internal-only screen would become
   * externally reachable despite its own declaration saying otherwise.
   *
   * With external clients in scope that widening is a matter of when, so the
   * narrower declaration is honoured now rather than after it matters.
   *
   * An undeclared id falls back to the satellite's audience; the handler answers
   * 404 for it regardless, and 404 rather than 403 is what keeps an unknown id
   * indistinguishable from a forbidden one.
   */
  const screenAudience = new Map(declared.screens.map((s) => [s.id, s.audience]));
  const actionAudience = new Map(declared.actions.map((a) => [a.id, a.audience]));

  function requireAccess(
    rbacScopes: readonly string[],
    resolveAudience: (req: AuthedRequest) => readonly Audience[],
  ) {
    return (req: AuthedRequest, res: Response, next: NextFunction): void => {
      // Default-deny rather than assert. A `req.principal!` here turns a route
      // mounted without `authenticate` into a TypeError — an unauthenticated
      // request answered with a 500 instead of a 401.
      const principal = req.principal;
      if (principal === undefined) {
        res.status(401).json({ error: "missing bearer token" });
        return;
      }
      const result = authorize(principal, { audience: resolveAudience(req), rbacScopes });
      if (!result.allowed) {
        res.status(result.status).json({ error: result.reason });
        return;
      }
      next();
    };
  }

  const forScreen = (req: AuthedRequest): readonly Audience[] => {
    // Express types a path param as `string | string[]`; a repeated segment
    // would arrive as an array and must not be coerced into a lookup key.
    const screenId = req.params["screenId"];
    if (typeof screenId !== "string") return declared.audience;
    return screenAudience.get(screenId) ?? declared.audience;
  };

  const forAction = (actionId: string) => (): readonly Audience[] =>
    actionAudience.get(actionId) ?? declared.audience;

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", protocol: CURRENT_PROTOCOL_VERSION });
  });

  // The manifest describes capabilities, not data, so it needs no principal.
  app.get("/portal/manifest", (_req, res) => {
    res.json(declared);
  });

  app.get(
    "/portal/screens/:screenId",
    authenticate,
    requireAccess(["orders.read"], forScreen),
    (req: AuthedRequest, res) => {
      const tenantId = req.principal!.tenantId;

      switch (req.params.screenId) {
        case "orders.list":
          res.json(listScreen(repository.list(tenantId)));
          return;

        case "orders.detail": {
          const id = typeof req.query["id"] === "string" ? req.query["id"] : "";
          const order = repository.get(tenantId, id);
          // 404 rather than 403 on purpose: a 403 would confirm that an order
          // belonging to another tenant exists, which is itself a disclosure.
          if (!order) {
            res.status(404).json({ error: "order not found" });
            return;
          }
          res.json(detailScreen(order));
          return;
        }

        default:
          res.status(404).json({ error: "unknown screen" });
      }
    },
  );

  app.post(
    "/portal/actions/orders.approve",
    authenticate,
    requireAccess(["orders.write"], forAction("orders.approve")),
    (req: AuthedRequest, res) => {
      const tenantId = req.principal!.tenantId;
      const body = (req.body ?? {}) as { id?: unknown };

      if (typeof body.id !== "string" || body.id === "") {
        const response: ActionResponse = {
          protocol: CURRENT_PROTOCOL_VERSION,
          outcome: "validation",
          fieldErrors: { id: "An order id is required." },
        };
        res.json(response);
        return;
      }

      const result = repository.approve(tenantId, body.id);

      if (!result.ok && result.reason === "not-found") {
        res.status(404).json({ error: "order not found" });
        return;
      }

      if (!result.ok) {
        const response: ActionResponse = {
          protocol: CURRENT_PROTOCOL_VERSION,
          outcome: "error",
          toast: { level: "error", message: "Only pending orders can be approved." },
        };
        res.json(response);
        return;
      }

      // Success returns a patch rather than a whole screen: the hub replaces
      // one node instead of re-rendering, which is what keeps actions cheap.
      const response: ActionResponse = {
        protocol: CURRENT_PROTOCOL_VERSION,
        outcome: "ok",
        toast: { level: "success", message: `Order ${body.id} approved.` },
        patch: [{ targetId: "orders-table", ui: ordersTable(repository.list(tenantId)) }],
      };
      res.json(response);
    },
  );

  app.post("/portal/actions/:actionId", authenticate, (_req, res) => {
    res.status(404).json({ error: "unknown action" });
  });

  // Express's default handler renders the stack trace into the response body
  // whenever NODE_ENV is not "production" — which is exactly how the compose
  // stack runs it. Answer in JSON and keep the detail on the server side.
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const status =
      typeof error === "object" && error !== null && typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status >= 500 ? "internal error" : "bad request" });
  });

  return app;
}
