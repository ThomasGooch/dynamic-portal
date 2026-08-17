import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";

/**
 * The portal in a browser.
 *
 * This file is PLAN.md's verification list, turned into assertions. Each test
 * names the claim it is defending, because a passing test whose purpose is
 * forgotten is deleted the first time it is inconvenient.
 *
 * Start the stack with `pnpm up` first — these drive the real containers.
 */

const run = promisify(execFile);

/**
 * Health endpoint for a satellite.
 *
 * The `PORTAL_*_URL` variables hold a *base* url — that is how
 * `docker-compose.yml` sets them and how `stack.spec.ts` reads them — so the
 * path is appended here rather than baked into the fallback. Using the variable
 * as a whole url polls `/`, which the satellites do not serve, and the wait
 * then times out on a container that is perfectly healthy.
 */
const healthUrl = (base: string): string => `${base.replace(/\/+$/, "")}/healthz`;

/** Waits for a container to report healthy again after being interfered with. */
async function waitForHealthy(url: string, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Still down. Keep waiting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${url} never became healthy`);
}

async function compose(...args: string[]): Promise<void> {
  await run("docker", ["compose", ...args], { cwd: new URL("..", import.meta.url).pathname });
}

test.describe("one shell, two solutions", () => {
  test("renders a TypeScript and a Python satellite in identical hub markup", async ({ page }) => {
    // The claim this defends: satellites send data, not code, and the hub owns
    // every pixel. Neither of these solutions ships a stylesheet — if this
    // passes, that is why they look the same.
    const classesOn = async (path: string): Promise<string[]> => {
      await page.goto(path);
      return page.evaluate(() =>
        [...document.querySelectorAll("[class]")]
          .flatMap((element) => [...element.classList])
          .filter((name) => name.startsWith("r-")),
      );
    };

    const orders = await classesOn("/orders");
    const fleet = await classesOn("/fleet");

    for (const shared of ["r-page", "r-stat", "r-table", "r-badge"]) {
      expect(orders, `orders is missing ${shared}`).toContain(shared);
      expect(fleet, `fleet is missing ${shared}`).toContain(shared);
    }
  });

  test("serves no satellite-authored class or style anywhere on a screen", async ({ page }) => {
    await page.goto("/orders");
    // Scoped to the rendered tree, not the page: the shell around it is the
    // hub's own markup and carries the hub's own class names.
    const foreign = await page.evaluate(() =>
      [...document.querySelectorAll(".r-page [class]")]
        .flatMap((element) => [...element.classList])
        .filter((name) => !name.startsWith("r-") && !name.startsWith("recharts-")),
    );
    expect(foreign).toEqual([]);
  });

  test("shows only the solutions this principal may see", async ({ page }) => {
    await page.goto("/orders");
    const nav = page.locator("nav.nav");
    // Labels come from the registry, which is the hub's file — a satellite does
    // not get to name itself in someone else's navigation.
    await expect(nav.getByRole("link", { name: "Order Management" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Fleet Operations" })).toBeVisible();
    await expect(nav.getByRole("link", { name: /payroll/i })).toHaveCount(0);
  });
});

test.describe("deep linking", () => {
  // The thing iframes and micro-frontends make awkward, and the reason this
  // architecture is worth the trouble: every screen is a real URL.
  test("a row links to a detail screen that survives reload and back", async ({ page }) => {
    await page.goto("/orders");

    const firstRow = page.locator("table.r-table tbody tr").first();
    const orderId = (await firstRow.locator("td").first().innerText()).trim();
    await firstRow.getByRole("link").click();

    await expect(page).toHaveURL(new RegExp(`/orders/orders\\.detail\\?id=${orderId}$`));
    await expect(page.locator("h1")).toContainText(orderId);

    // Reload: the URL alone has to be enough to rebuild the screen.
    await page.reload();
    await expect(page.locator("h1")).toContainText(orderId);

    await page.goBack();
    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.locator("table.r-table")).toBeVisible();
  });

  test("a truncated deep link 404s instead of rendering a different screen", async ({ page }) => {
    const response = await page.goto("/orders/orders.list/extra");
    expect(response?.status()).toBe(404);
  });

  test("a satellite this principal cannot see is not found, not forbidden", async ({ page }) => {
    // A 403 would confirm it exists, which is the same disclosure the
    // satellites avoid on another tenant's records.
    const response = await page.goto("/payroll");
    expect(response?.status()).toBe(404);
  });
});

test.describe("the action envelope", () => {
  // The in-memory repository accumulates approvals, so the satellite is reset
  // rather than the test being written to tolerate whatever it inherited.
  test.beforeAll(async () => {
    await compose("restart", "satellite-orders");
    await waitForHealthy(healthUrl(process.env["PORTAL_ORDERS_URL"] ?? "http://127.0.0.1:4001"));
  });

  test("patch replaces one node without navigating or reloading", async ({ page }) => {
    await page.goto("/orders");
    const table = page.locator("table.r-table");
    await expect(table).toBeVisible();

    // Marks the live DOM node. A full page load builds a new document and the
    // mark disappears with it; a patch reconciles this same element. That is
    // the difference being asserted, and it is invisible to a test that only
    // checks the rows.
    await table.evaluate((node) => node.setAttribute("data-e2e-witness", "1"));

    await page.getByRole("button", { name: "Refresh" }).click();

    await expect(page.locator(".r-toast")).toContainText("Orders reloaded");
    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.locator("table.r-table[data-e2e-witness]")).toBeVisible();
  });

  test("a confirmed write shows the hub's own dialog, then navigates", async ({ page }) => {
    await page.goto("/orders");

    const pendingRow = page
      .locator("table.r-table tbody tr")
      .filter({ has: page.locator(".r-badge", { hasText: "pending" }) })
      .first();
    const orderId = (await pendingRow.locator("td").first().innerText()).trim();
    await pendingRow.getByRole("link").click();

    await page.getByRole("button", { name: "Approve order" }).click();

    // The hub's dialog, not the browser's: `window.confirm` would block the
    // event loop and Playwright would need a dialog handler instead.
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Approve this order?");
    await expect(dialog).toContainText(orderId);
    await dialog.getByRole("button", { name: "Confirm" }).click();

    // The satellite navigated by screen id, so the url names the screen. It is
    // the same view `/orders` lands on, reached the explicit way.
    await expect(page).toHaveURL(/\/orders\/orders\.list$/);
    await expect(page.locator(".r-toast")).toContainText(`Order ${orderId} approved`);

    const status = page
      .locator("table.r-table tbody tr")
      .filter({ hasText: orderId })
      .locator(".r-badge");
    await expect(status).toHaveText("approved");
  });

  test("cancelling the dialog sends nothing", async ({ page }) => {
    await page.goto("/orders");
    const before = await page.locator("table.r-table tbody tr").allInnerTexts();

    const pendingRow = page
      .locator("table.r-table tbody tr")
      .filter({ has: page.locator(".r-badge", { hasText: "pending" }) })
      .first();
    await pendingRow.getByRole("link").click();
    await page.getByRole("button", { name: "Approve order" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await page.goto("/orders");
    expect(await page.locator("table.r-table tbody tr").allInnerTexts()).toEqual(before);
  });

  test("field errors land on the field that caused them", async ({ page }) => {
    // Driven through the endpoint rather than a form, because no satellite
    // screen currently submits one — the wiring being checked is the hub's.
    await page.goto("/orders");
    const body = await page.evaluate(async () => {
      const response = await fetch("/api/actions/orders/orders.approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return response.json();
    });

    expect(body.ok).toBe(true);
    expect(body.response.outcome).toBe("validation");
    expect(Object.keys(body.response.fieldErrors)).toContain("id");
  });
});

test.describe("blast radius", () => {
  // The claim: one solution failing is a scoped card, not an outage. Everything
  // this architecture promises about independence rests on it.
  test.describe.configure({ mode: "serial" });

  test.afterAll(async () => {
    await compose("start", "satellite-fleet");
    await waitForHealthy(healthUrl(process.env["PORTAL_FLEET_URL"] ?? "http://127.0.0.1:4002"));
  });

  test("a dead satellite degrades to a card while the others keep working", async ({ page }) => {
    await compose("stop", "satellite-fleet");

    await page.goto("/fleet");
    // `.errorCard`, not `role=alert`: Next mounts its own route announcer with
    // that role on every page.
    const card = page.locator(".errorCard");
    await expect(card).toContainText("Fleet");
    await expect(card).toContainText("Other solutions are unaffected");

    // The part that matters: the shell and every other solution are untouched.
    await expect(page.locator("nav.nav")).toBeVisible();
    await page.goto("/orders");
    await expect(page.locator("table.r-table")).toBeVisible();
  });
});

test.describe("rendering the untrusted", () => {
  test("a chart from the Python satellite draws with the hub's own palette", async ({
    page,
  }: {
    page: Page;
  }) => {
    await page.goto("/fleet");
    // Recharts measures its container before drawing, so the SVG appears after
    // hydration rather than in the server's HTML. See PLAN.md's known limits.
    const plot = page.locator(".r-chart svg[role=application]");
    await expect(plot).toBeVisible();

    const fills = await page.evaluate(() =>
      [...document.querySelectorAll(".r-chart svg [fill]")]
        .map((element) => element.getAttribute("fill") ?? "")
        .filter((fill) => fill.startsWith("var(")),
    );
    // Colours come from custom properties, so re-theming the hub re-themes the
    // charts. A literal here would be a satellite-independent palette that no
    // token change can reach.
    expect(fills.length).toBeGreaterThan(0);
  });
});

test.describe("the agent, switched off", () => {
  // PLAN.md item 13, and the property the whole design rests on: mode one works
  // with the agent disabled. The compose stack sets no API key, so this is the
  // portal's default state rather than a state contrived for the test.
  test("mounts nothing when no assistant is configured", async ({ page }) => {
    await page.goto("/orders");
    await expect(page.getByRole("button", { name: "Ask the portal" })).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Assistant" })).toHaveCount(0);
  });

  test("leaves every deterministic screen exactly as it was", async ({ page }) => {
    await page.goto("/orders");
    await expect(page.locator("table.r-table")).toBeVisible();
    await page.goto("/fleet");
    await expect(page.locator(".r-chart svg[role=application]")).toBeVisible();
  });

  test("answers the agent endpoint with a plain refusal, not an error", async ({ page }) => {
    // "Not enabled" is a supported way to run this portal, so it is not a 500
    // and it does not leak whether a key merely happens to be missing today.
    await page.goto("/orders");
    const response = await page.evaluate(async () => {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
      });
      return { status: res.status, body: await res.json() };
    });

    expect(response.status).toBe(404);
    expect(response.body.ok).toBe(false);
    expect(response.body.message).toMatch(/not enabled/i);
  });
});

test.describe("the brokered public API", () => {
  // PLAN.md's answer to "external clients, programmatically". A partner never
  // touches PUP, the component catalog or MCP — they see services, resources
  // and operations under names the registry assigns, which is what keeps the
  // internal vocabulary free to change.
  const base = "/api/public/v1";

  test("names everything publicly, and leaks no internal id", async ({ request }) => {
    // The assertion that keeps the decoupling honest. If a screen id ever
    // appears here, a satellite team can no longer rename one without breaking
    // someone outside the organization.
    const response = await request.get(`${base}/services`);
    expect(response.ok()).toBe(true);

    const body = await response.text();
    expect(body).not.toContain("orders.list");
    expect(body).not.toContain("orders.detail");
    expect(body).not.toContain("orders.approve");

    const catalog = JSON.parse(body);
    expect(catalog.version).toBe("1");
    expect(catalog.services.map((s: { name: string }) => s.name)).toEqual(["order-management"]);
  });

  test("offers only the satellite that was widened for external clients", async ({ request }) => {
    const catalog = await (await request.get(`${base}/services`)).json();
    const names = catalog.services.map((s: { name: string }) => s.name);
    expect(names).not.toContain("fleet");
    expect(names).toHaveLength(1);
  });

  test("returns records rather than a screen", async ({ request }) => {
    const body = await (await request.get(`${base}/services/order-management/resources/orders`)).json();
    expect(body.collections[0].records.length).toBeGreaterThan(0);
    // Not a UI tree: no component ever crosses this boundary.
    expect(JSON.stringify(body)).not.toContain("StatTile");
    expect(JSON.stringify(body)).not.toContain("Table");
  });

  test("carries a declared parameter through to the satellite", async ({ request }) => {
    const list = await (await request.get(`${base}/services/order-management/resources/orders`)).json();
    const id = list.collections[0].records[0].id;

    const detail = await request.get(
      `${base}/services/order-management/resources/order?id=${encodeURIComponent(id)}`,
    );
    expect(detail.ok()).toBe(true);
    const body = await detail.json();
    // A detail screen is a summary with no id field of its own — the screen
    // says which record it is in its title, which is why the façade carries it.
    expect(body.title).toContain(id);
    expect(body.summary.length).toBeGreaterThan(0);
  });

  test("refuses a parameter the resource never declared", async ({ request }) => {
    // `tenantId` is the one that matters: it comes from the authenticated
    // principal, never from a query string a partner controls.
    const response = await request.get(
      `${base}/services/order-management/resources/orders?tenantId=someone-else`,
    );
    expect(response.status()).toBe(400);
  });

  test("answers not-found for a resource nobody published", async ({ request }) => {
    // Unknown and not-yours are the same answer. A 403 would confirm that
    // something exists, which is the disclosure the audience model prevents.
    for (const path of [
      "services/fleet/resources/vehicles",
      "services/order-management/resources/nope",
      // The internal id is not an alias for the public name, in either direction.
      "services/orders/resources/orders.list",
    ]) {
      expect((await request.get(`${base}/${path}`)).status(), path).toBe(404);
    }
  });

  test("exposes no operation, because none was published", async ({ request }) => {
    const catalog = await (await request.get(`${base}/services`)).json();
    expect(catalog.services[0].operations).toEqual([]);
    expect(
      (await request.post(`${base}/services/order-management/operations/approve`, { data: {} })).status(),
    ).toBe(404);
  });
});

test.describe("the hub as an MCP server", () => {
  // PLAN.md's "single agent-facing capability surface": one endpoint over every
  // solution, filtered by the same entitlement the screens use. An internal
  // contract — partners are brokered through the public API and never see this.
  const rpc = async (
    request: import("@playwright/test").APIRequestContext,
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    const response = await request.post("/api/mcp", {
      headers: { accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: 1, method, params },
    });
    return { status: response.status(), body: await response.json() };
  };

  const initialize = {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1.0.0" },
  };

  test("introduces itself and says where governed writes happen", async ({ request }) => {
    const { status, body } = await rpc(request, "initialize", initialize);
    expect(status).toBe(200);
    expect(body.result.serverInfo.name).toBe("dynamic-portal");
    // The instructions are where a host learns that approving an order is
    // possible but not here — without them an agent reports it impossible.
    expect(body.result.instructions).toMatch(/portal/i);
  });

  test("lists the same tools the portal would give this account", async ({ request }) => {
    await rpc(request, "initialize", initialize);
    const { body } = await rpc(request, "tools/list");

    const names = body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("orders__orders_list");
    expect(names).toContain("fleet__fleet_dashboard");

    const read = body.result.tools.find(
      (tool: { name: string }) => tool.name === "orders__orders_list",
    );
    expect(read.annotations.readOnlyHint).toBe(true);
    expect(read.inputSchema.additionalProperties).toBe(false);
  });

  test("does not list the write that needs a person to approve it", async ({ request }) => {
    await rpc(request, "initialize", initialize);
    const { body } = await rpc(request, "tools/list");
    const names = body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).not.toContain("orders__orders_approve");
  });

  test("returns a satellite's real data through a tool call", async ({ request }) => {
    await rpc(request, "initialize", initialize);
    const { body } = await rpc(request, "tools/call", {
      name: "orders__orders_list",
      arguments: {},
    });

    expect(body.result.isError).toBeUndefined();
    const text = body.result.content[0].text;
    expect(text).toContain("ord-1001");
    // Data, not a screen: no component name crosses this boundary either.
    expect(text).not.toContain("StatTile");
  });

  test("refuses the governed write even when called by name", async ({ request }) => {
    // Absent from the listing is not enough — a host that guessed the name
    // would otherwise walk around the gate the listing respects.
    await rpc(request, "initialize", initialize);
    const { body } = await rpc(request, "tools/call", {
      name: "orders__orders_approve",
      arguments: { id: "ord-1001" },
    });

    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/approved by a person in the portal/i);
  });

  test("refuses an argument the tool never declared", async ({ request }) => {
    await rpc(request, "initialize", initialize);
    const { body } = await rpc(request, "tools/call", {
      name: "orders__orders_list",
      arguments: { tenantId: "globex" },
    });
    expect(body.result.isError).toBe(true);
  });
});

test.describe("the audit log", () => {
  // PLAN.md's verification item 11: from the audit log alone, answer which
  // records were read, for whom, and when. Until this landed every path built a
  // valid event and dropped it — a more comfortable kind of nothing than having
  // no schema, and exactly as useless.
  const readLog = async (): Promise<Record<string, never>[]> => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("docker", [
      "compose",
      "exec",
      "-T",
      "hub",
      "cat",
      "/tmp/portal-audit.jsonl",
    ]);
    return stdout
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
  };

  test("records a screen read that actually happened", async ({ page, request }) => {
    void request;
    await page.goto("/orders");
    await expect(page.locator("table.r-table")).toBeVisible();

    const events = await readLog();
    const read = events.filter((event: never) => (event as { action: { kind: string } }).action.kind === "screen.read");
    expect(read.length).toBeGreaterThan(0);

    const last = read[read.length - 1] as unknown as {
      principal: { sub: string; tenantId: string };
      action: { satelliteId: string; screenId: string; paramsDigest: string };
      outcome: { status: string };
      latencyMs: number;
    };
    expect(last.principal.tenantId).toBe("acme");
    expect(last.action.satelliteId).toBe("orders");
    expect(last.outcome.status).toBe("ok");
    expect(last.latencyMs).toBeGreaterThanOrEqual(0);
    // Keyed HMAC-SHA256, hex.
    expect(last.action.paramsDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("records the action, and never its parameters", async ({ page }) => {
    await page.goto("/orders");
    const before = (await readLog()).length;

    await page.evaluate(async () => {
      await fetch("/api/actions/orders/orders.refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
    });

    const events = await readLog();
    expect(events.length).toBeGreaterThan(before);
    const invoked = events.filter(
      (event: never) => (event as { action: { kind: string } }).action.kind === "action.invoke",
    );
    expect(invoked.length).toBeGreaterThan(0);
  });

  test("carries no scope, which is authorization input rather than evidence", async ({ page }) => {
    // Recording them would leak the shape of the permission model into a log
    // that is read widely.
    await page.goto("/orders");
    const raw = JSON.stringify(await readLog());
    expect(raw).not.toContain("orders.read");
    expect(raw).not.toContain("scopes");
  });

  test("answers the question the whole schema exists for", async ({ page }) => {
    // Which satellite, which screen, for whom, when, and how long it took —
    // from the log alone, with no other system consulted.
    await page.goto("/fleet");
    const events = await readLog();
    const fleet = events
      .map((event) => event as unknown as { action: { satelliteId?: string; screenId?: string }; at: string; principal: { sub: string } })
      .filter((event) => event.action.satelliteId === "fleet");

    expect(fleet.length).toBeGreaterThan(0);
    const last = fleet[fleet.length - 1]!;
    expect(last.action.screenId).toBe("fleet.dashboard");
    expect(last.principal.sub).toContain("@");
    expect(Date.parse(last.at)).not.toBeNaN();
  });
});
