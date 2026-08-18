import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { OrderRepository, seedOrders } from "./repository";
import { signPrincipal } from "@portal/identity";
import { validateNested } from "@portal/catalog";
import type { UiNode } from "@portal/protocol";

/**
 * The write path, which until now was one button that changed one field.
 *
 * These exist because the read path was proven three times over and the
 * mutation surface was not: no create, no update, and every text input in the
 * catalog unrendered by any satellite.
 */

const SECRET = "crud-test-secret";

const token = (scopes: string[], tenantId = "acme") =>
  signPrincipal(
    { sub: "alice@acme.example", tenantId, audience: "internal", scopes },
    SECRET,
  );

const WRITE = token(["orders.read", "orders.write"]);
const READ_ONLY = token(["orders.read"]);

/** Far enough out that the suite does not start failing on a Tuesday. */
const dueBy = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

const validDraft = {
  customer: "Wile E. Coyote",
  contactEmail: "wile@acme.example",
  total: 129.5,
  currency: "USD",
  dueBy,
  priority: "express",
  tags: ["retail"],
  expedited: true,
  notes: "Leave at the loading dock.",
};

let server: Server;
let baseUrl: string;
let repository: OrderRepository;

// A fresh store per test: these mutate, and a suite whose outcome depends on
// which test ran first is a suite that passes alone and fails in CI.
beforeEach(async () => {
  repository = new OrderRepository(seedOrders());
  const app = createApp({ repository, principalSecret: SECRET });
  server = await new Promise<Server>((resolve) => {
    // Port 0 → the OS picks a free port, so suites never collide.
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

/** Only what these tests read. Loose on purpose: the schemas are checked by
 *  the protocol package, and re-declaring them here would be a second copy to
 *  keep in step. */
interface Body {
  readonly outcome: string;
  readonly navigate: { readonly screenId: string; readonly params: Record<string, string> };
  readonly fieldErrors: Record<string, string>;
  readonly ui: UiNode;
}

async function post(action: string, body: unknown, auth = WRITE) {
  const response = await fetch(`${baseUrl}/portal/actions/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Body };
}

async function screen(id: string, query = "", auth = WRITE) {
  const response = await fetch(`${baseUrl}/portal/screens/${id}${query}`, {
    headers: { authorization: `Bearer ${auth}` },
  });
  return { status: response.status, body: (await response.json()) as Body };
}

describe("the form the hub renders", () => {
  it("is a tree the catalog accepts", async () => {
    // The claim the whole vocabulary rests on. A form the catalog rejects is a
    // screen the hub refuses whole, so this is the check that matters most.
    const response = await screen("orders.new");
    expect(response.status).toBe(200);
    expect(validateNested(response.body.ui).ok).toBe(true);
  });

  it("renders every input the order needs", async () => {
    const types = JSON.stringify((await screen("orders.new")).body.ui);
    for (const component of [
      "TextField", "NumberField", "Select", "DateField",
      "MultiSelect", "RadioGroup", "Checkbox", "TextArea",
    ]) {
      expect(types, `${component} is missing from the form`).toContain(`"${component}"`);
    }
  });

  it("comes back filled in when editing", async () => {
    const body = JSON.stringify((await screen("orders.edit", "?id=ord-1001")).body);
    expect(body).toContain("Wile E. Coyote");
    // The id rides in a Hidden field rather than the URL, so the action does
    // not have to trust a query parameter it never issued.
    expect(body).toContain('"Hidden"');
  });

  it("refuses to edit another tenant's order without saying it exists", async () => {
    expect((await screen("orders.edit", "?id=ord-2001")).status).toBe(404);
  });
});

describe("creating an order", () => {
  it("creates it and navigates to what was created", async () => {
    const before = repository.list("acme").length;
    const response = await post("orders.create", validDraft);

    expect(response.body.outcome).toBe("ok");
    expect(response.body.navigate.screenId).toBe("orders.detail");
    expect(repository.list("acme")).toHaveLength(before + 1);

    const created = repository.get("acme", response.body.navigate.params["id"] ?? "");
    expect(created?.customer).toBe("Wile E. Coyote");
    // The satellite sets these, not the form.
    expect(created?.status).toBe("pending");
    expect(created?.tenantId).toBe("acme");
  });

  it("creates it for the principal's tenant, whatever the body claims", async () => {
    // A create that honoured a tenant in the payload would be a cross-tenant
    // write with extra steps.
    const response = await post("orders.create", { ...validDraft, tenantId: "globex" });
    const created = repository.get("acme", response.body.navigate.params["id"] ?? "");

    expect(created).toBeDefined();
    expect(repository.list("globex").map((o) => o.id)).not.toContain(created!.id);
  });

  it("needs the write scope", async () => {
    expect((await post("orders.create", validDraft, READ_ONLY)).status).toBe(403);
  });

  it("names every field that is wrong, all at once", async () => {
    // One round trip, not one per mistake.
    const response = await post("orders.create", {
      customer: "",
      contactEmail: "not-an-address",
      total: -5,
      currency: "XYZ",
      dueBy: "yesterday",
      priority: "urgent",
    });

    expect(response.body.outcome).toBe("validation");
    expect(Object.keys(response.body.fieldErrors).sort()).toEqual(
      ["contactEmail", "currency", "customer", "dueBy", "priority", "total"],
    );
  });

  it("refuses a due date in the past", async () => {
    const response = await post("orders.create", { ...validDraft, dueBy: "2020-01-01" });
    expect(response.body.fieldErrors.dueBy).toMatch(/passed/i);
  });

  it("changes nothing when it refuses", async () => {
    const before = repository.list("acme").length;
    await post("orders.create", { ...validDraft, customer: "" });
    expect(repository.list("acme")).toHaveLength(before);
  });
});

describe("the rules a single field cannot express", () => {
  // The reason a form vocabulary is harder than a table one. None of these is
  // a per-input constraint, and every real form has them.
  it("refuses an expedited order at standard priority", async () => {
    const response = await post("orders.create", {
      ...validDraft, priority: "standard", expedited: true,
    });
    expect(response.body.fieldErrors.priority).toMatch(/standard/i);
  });

  it("requires notes on a hazmat order", async () => {
    const response = await post("orders.create", {
      ...validDraft, tags: ["hazmat"], notes: "",
    });
    expect(response.body.fieldErrors.notes).toMatch(/hazmat/i);
  });

  it("requires a critical order to be expedited", async () => {
    const response = await post("orders.create", {
      ...validDraft, priority: "critical", expedited: false,
    });
    expect(response.body.fieldErrors.expedited).toMatch(/critical/i);
  });

  it("keys every message to a field the form actually renders", async () => {
    // A message keyed to a name no input carries renders nowhere, so the user
    // is told something is wrong and never which.
    const form = JSON.stringify((await screen("orders.new")).body.ui);
    const response = await post("orders.create", {
      ...validDraft, priority: "critical", expedited: false, customer: "",
    });

    for (const field of Object.keys(response.body.fieldErrors)) {
      expect(form, `nothing on the form is named ${field}`).toContain(`"name":"${field}"`);
    }
  });
});

describe("updating an order", () => {
  it("changes the editable fields and leaves the rest alone", async () => {
    const response = await post("orders.update", {
      ...validDraft, id: "ord-1001", customer: "Coyote Holdings",
    });

    expect(response.body.outcome).toBe("ok");
    const updated = repository.get("acme", "ord-1001");
    expect(updated?.customer).toBe("Coyote Holdings");
    // A form that could rewrite these would let a user approve by editing.
    expect(updated?.status).toBe("pending");
    expect(updated?.tenantId).toBe("acme");
  });

  it("refuses a shipped order, because editing one describes nothing", async () => {
    const response = await post("orders.update", { ...validDraft, id: "ord-1002" });
    expect(response.body.outcome).toBe("error");
    expect(repository.get("acme", "ord-1002")?.customer).toBe("Road Runner Logistics");
  });

  it("will not touch another tenant's order", async () => {
    const response = await post("orders.update", { ...validDraft, id: "ord-2001" });
    expect(response.status).toBe(404);
    expect(repository.get("globex", "ord-2001")?.customer).toBe("Globex Retail");
  });

  it("validates before it writes", async () => {
    await post("orders.update", { ...validDraft, id: "ord-1001", contactEmail: "nope" });
    expect(repository.get("acme", "ord-1001")?.customer).toBe("Wile E. Coyote");
  });
});

describe("deleting an order", () => {
  it("removes a pending one and returns to the list", async () => {
    const response = await post("orders.delete", { id: "ord-1001" });

    expect(response.body.outcome).toBe("ok");
    expect(response.body.navigate.screenId).toBe("orders.list");
    expect(repository.get("acme", "ord-1001")).toBeUndefined();
  });

  it("refuses one that is no longer pending", async () => {
    const response = await post("orders.delete", { id: "ord-1002" });
    expect(response.body.outcome).toBe("error");
    expect(repository.get("acme", "ord-1002")).toBeDefined();
  });

  it("will not delete another tenant's order", async () => {
    const response = await post("orders.delete", { id: "ord-2001" });
    expect(response.status).toBe(404);
    expect(repository.get("globex", "ord-2001")).toBeDefined();
  });
});
