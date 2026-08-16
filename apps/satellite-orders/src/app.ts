import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { CURRENT_PROTOCOL_VERSION, type ActionResponse } from "@portal/protocol";
import { InvalidPrincipalError, verifyPrincipal, type Principal } from "./principal.js";
import type { OrderRepository } from "./repository.js";
import { detailScreen, listScreen, manifest, ordersTable } from "./screens.js";

export interface AppOptions {
  repository: OrderRepository;
  principalSecret: string;
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
export function createApp({ repository, principalSecret }: AppOptions): Express {
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

  function requireScope(scope: string) {
    return (req: AuthedRequest, res: Response, next: NextFunction): void => {
      if (!req.principal?.scopes.includes(scope)) {
        res.status(403).json({ error: `missing scope ${scope}` });
        return;
      }
      next();
    };
  }

  /**
   * Default-deny audience, enforced by the satellite rather than assumed of the
   * hub. This satellite declares itself internal-only; a principal minted for a
   * different audience must not reach tenant data even with a valid signature.
   */
  const declaredAudience = manifest().audience;
  function requireAudience(req: AuthedRequest, res: Response, next: NextFunction): void {
    if (!declaredAudience.includes(req.principal!.audience)) {
      res.status(403).json({ error: "audience not permitted" });
      return;
    }
    next();
  }

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", protocol: CURRENT_PROTOCOL_VERSION });
  });

  // The manifest describes capabilities, not data, so it needs no principal.
  app.get("/portal/manifest", (_req, res) => {
    res.json(manifest());
  });

  app.get("/portal/screens/:screenId", authenticate, requireAudience, (req: AuthedRequest, res) => {
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
  });

  app.post(
    "/portal/actions/orders.approve",
    authenticate,
    requireAudience,
    requireScope("orders.write"),
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
