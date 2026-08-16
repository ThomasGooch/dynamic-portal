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
