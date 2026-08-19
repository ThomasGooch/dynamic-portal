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

  it("is still a tree the catalog accepts once it is filled in", async () => {
    // The empty form was checked; the filled one was not, and edit mode is
    // where the values, the `Hidden` id and the alert are added.
    const response = await screen("orders.edit", "?id=ord-1003");
    expect(response.status).toBe(200);
    expect(validateNested(response.body.ui).ok).toBe(true);
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
    // The changed field has to differ from what is stored, or the assertion
    // holds just as well against an implementation that wrote the whole draft
    // through — which is what this test used to do.
    const before = repository.get("acme", "ord-1001");
    const response = await post("orders.update", {
      ...validDraft,
      id: "ord-1001",
      customer: "Should Not Be Written Ltd",
      contactEmail: "nope",
    });

    expect(response.body.outcome).toBe("validation");
    expect(repository.get("acme", "ord-1001")).toEqual(before);
  });

  it("judges the cross-field rules against the labels the order will end up with", async () => {
    // An update that never mentions `tags` — the parameter is optional, so this
    // is a shape any caller can post. The order keeps its `hazmat` label, so
    // the rule that says a hazmat order needs handling notes has to be applied
    // to the label the order still has rather than to the empty list the
    // payload implies.
    const hazmat = { ...validDraft, id: "ord-1003", tags: ["hazmat"], notes: "Handle with care." };
    expect((await post("orders.update", hazmat)).body.outcome).toBe("ok");

    const { tags: _tags, ...withoutTags } = hazmat;
    const response = await post("orders.update", { ...withoutTags, notes: "" });

    expect(response.body.outcome).toBe("validation");
    expect(response.body.fieldErrors["notes"]).toMatch(/hazmat/i);
    expect(repository.get("acme", "ord-1003")?.notes).toBe("Handle with care.");
  });

  it("clears a note when the box is emptied", async () => {
    // A field-by-field write, not `Object.assign`: an absent optional would
    // otherwise leave the old note in place, and the one edit a user cannot
    // make is the one that removes something.
    await post("orders.update", { ...validDraft, id: "ord-1003", notes: "Ring the bell." });
    expect(repository.get("acme", "ord-1003")?.notes).toBe("Ring the bell.");

    await post("orders.update", { ...validDraft, id: "ord-1003", notes: "" });
    expect(repository.get("acme", "ord-1003")?.notes).toBeUndefined();
  });

  it("leaves the fields the satellite owns exactly as they were", async () => {
    const before = repository.get("acme", "ord-1003")!;
    await post("orders.update", {
      ...validDraft,
      id: "ord-1003",
      // Every reserved field, named in the body on purpose.
      status: "approved",
      tenantId: "globex",
      placedAt: "1999-01-01T00:00:00Z",
      blockedByVehicleId: "veh-999",
    });

    const after = repository.get("acme", "ord-1003")!;
    expect(after.status).toBe(before.status);
    expect(after.tenantId).toBe(before.tenantId);
    expect(after.placedAt).toBe(before.placedAt);
    expect(after.blockedByVehicleId).toBe(before.blockedByVehicleId);
    expect(after.customer).toBe(validDraft.customer);
  });

  it("keeps labels an update never mentioned", async () => {
    // `tags` is declarable and optional, so an agent editing one field can
    // leave it out. Reading absent as empty would strip `hazmat` off an order
    // as a side effect of editing its customer name, and take the
    // handling-notes rule with it.
    const { tags: _unmentioned, ...withoutTags } = validDraft;
    await post("orders.update", { ...withoutTags, id: "ord-1003", customer: "Renamed Ltd" });

    const after = repository.get("acme", "ord-1003");
    expect(after?.customer).toBe("Renamed Ltd");
    expect(after?.tags).toEqual(["wholesale", "priority"]);
  });

  it("still lets the form clear every label, because it sends an empty list", async () => {
    // The other half: absent is "unchanged", `[]` is "none". An empty
    // `MultiSelect` posts `[]`, so removing the last label stays a change a
    // user can make.
    await post("orders.update", { ...validDraft, id: "ord-1003", tags: [] });
    expect(repository.get("acme", "ord-1003")?.tags).toEqual([]);
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

  it("never hands a deleted order's id to the next one", async () => {
    // An id derived from the highest one present goes backwards over a delete,
    // and the replacement then answers to every link, log line and audit entry
    // that meant the order that was removed.
    const first = await post("orders.create", validDraft);
    const reused = first.body.navigate.params["id"] ?? "";

    expect((await post("orders.delete", { id: reused })).body.outcome).toBe("ok");

    const second = await post("orders.create", validDraft);
    expect(second.body.navigate.params["id"]).not.toBe(reused);
  });
});

describe("what the store hands back", () => {
  it("does not share a mutable array with its caller", async () => {
    // `{ ...order }` copies the reference, not the array. A screen builder that
    // sorted `tags` in place would be editing the record it was rendering.
    const listed = repository.list("acme").find((o) => o.id === "ord-1003")!;
    listed.tags.push("hazmat");

    expect(repository.get("acme", "ord-1003")?.tags).not.toContain("hazmat");
  });
});

describe("values that are not what they look like", () => {
  it("refuses a total that is only partly a number", async () => {
    // `Number.parseFloat` reads a prefix, so `"250abc"` becomes 250 and an
    // order nobody placed is stored as if they had.
    const response = await post("orders.create", { ...validDraft, total: "250abc" });
    expect(response.body.outcome).toBe("validation");
    expect(response.body.fieldErrors["total"]).toBeDefined();
  });

  it("refuses a total finer than the currency is", async () => {
    const response = await post("orders.create", { ...validDraft, total: 10.005 });
    expect(response.body.fieldErrors["total"]).toBeDefined();
  });

  it("refuses labels that are not labels rather than dropping them", async () => {
    const response = await post("orders.create", { ...validDraft, tags: ["retail", 7] });
    expect(response.body.outcome).toBe("validation");
    expect(response.body.fieldErrors["tags"]).toBeDefined();
  });

  it("collapses a label repeated in the body", async () => {
    const response = await post("orders.create", {
      ...validDraft,
      tags: ["retail", "retail"],
      priority: "express",
    });
    const created = repository.get("acme", response.body.navigate.params["id"] ?? "");
    expect(created?.tags).toEqual(["retail"]);
  });

  it("refuses a checkbox value it cannot read, rather than calling it unticked", async () => {
    // Silently reading `1` as false would then reject the *priority* of an
    // order whose real problem is a field the user believes they ticked.
    const response = await post("orders.create", { ...validDraft, expedited: 1 });
    expect(response.body.fieldErrors["expedited"]).toBeDefined();
  });

  it("never lets a cross-field rule overwrite the message already on a field", async () => {
    // `expedited` is unreadable *and* the priority is critical. The user needs
    // to be told about the value, not about the consequence.
    const response = await post("orders.create", {
      ...validDraft, priority: "critical", expedited: "maybe",
    });
    expect(response.body.fieldErrors["expedited"]).not.toMatch(/critical/i);
  });
});


describe("what an external principal is offered", () => {
  // The façade lets a customer read their own orders. Every write here is
  // `audience: ["internal"]`, so the satellite answers 403 — and a screen that
  // drew the buttons anyway would offer a customer three things that fail when
  // clicked. The authorization was never wrong; the screen was.
  const EXTERNAL = signPrincipal(
    { sub: "buyer@acme.example", tenantId: "acme", audience: "external", scopes: ["orders.read"] },
    SECRET,
  );

  it("is shown its orders", async () => {
    const response = await screen("orders.list", "", EXTERNAL);
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).toContain("Wile E. Coyote");
  });

  it("is offered no control that would answer 403", async () => {
    const list = JSON.stringify((await screen("orders.list", "", EXTERNAL)).body);
    const detail = JSON.stringify((await screen("orders.detail", "?id=ord-1001", EXTERNAL)).body);

    for (const action of ["orders.create", "orders.update", "orders.delete", "orders.approve"]) {
      expect(list, `the list offers ${action}`).not.toContain(action);
      expect(detail, `the detail offers ${action}`).not.toContain(action);
    }
    expect(detail).not.toContain("orders.edit");
  });

  it("still gets them when internal, so the guard is not simply hiding everything", async () => {
    // Without this the test above passes against a screen builder that dropped
    // the buttons for everyone.
    const detail = JSON.stringify((await screen("orders.detail", "?id=ord-1001")).body);
    expect(detail).toContain("orders.delete");
    expect(detail).toContain("orders.edit");
  });
});


describe("conditional fields", () => {
  // The form draws `notes` only for a hazmat order and `expediteReason` only
  // once expedite is ticked. That is presentation. These check the server does
  // not believe it.
  it("declares the conditions on the fields the hub will evaluate", async () => {
    const form = JSON.stringify((await screen("orders.new")).body.ui);
    expect(form).toContain('"visibleWhen":{"field":"tags","oneOf":["hazmat"]}');
    expect(form).toContain('"visibleWhen":{"field":"expedited","equals":true}');
  });

  it("still refuses a hazmat order with no notes, hidden field or not", async () => {
    // The field the user never saw. A caller can post straight to the action,
    // so the rule has to live here as well as in the form.
    const response = await post("orders.create", { ...validDraft, tags: ["hazmat"], notes: "" });
    expect(response.body.outcome).toBe("validation");
    expect(response.body.fieldErrors["notes"]).toMatch(/hazmat/i);
  });

  it("drops a reason posted for an order that is not expedited", async () => {
    // Ticking expedite, typing a reason, then unticking leaves the value in
    // the DOM. Storing it would describe an order that is not expedited.
    const response = await post("orders.create", {
      ...validDraft,
      priority: "standard",
      expedited: false,
      expediteReason: "signed off by finance",
    });

    expect(response.body.outcome).toBe("ok");
    const created = repository.get("acme", response.body.navigate.params["id"] ?? "");
    expect(created?.expediteReason).toBeUndefined();
  });

  it("keeps the reason when the order really is expedited", async () => {
    const response = await post("orders.create", {
      ...validDraft,
      expedited: true,
      priority: "express",
      expediteReason: "signed off by finance",
    });

    // Asserted before reading the record: without this, a validation failure
    // reads as "the field was not stored" and the test blames the wrong thing.
    expect(response.body.outcome, JSON.stringify(response.body.fieldErrors)).toBe("ok");
    const created = repository.get("acme", response.body.navigate.params["id"] ?? "");
    expect(created?.expediteReason).toBe("signed off by finance");
  });

  it("does not lose the reason when the order is edited without retyping it", async () => {
    // A conditional field is still a field on the edit form. If it comes back
    // empty, the edit posts no reason and `update` reads that as "not expedited
    // any more" and deletes the stored one — set once, then silently erased by
    // an edit that never mentioned it.
    const created = await post("orders.create", {
      ...validDraft,
      expedited: true,
      priority: "express",
      expediteReason: "signed off by finance",
    });
    const id = created.body.navigate.params["id"] ?? "";

    const form = JSON.stringify((await screen("orders.edit", `?id=${id}`)).body.ui);
    expect(form).toContain("signed off by finance");

    const edited = await post("orders.update", {
      ...validDraft,
      id,
      customer: "Acme Corp",
      expedited: true,
      priority: "express",
      expediteReason: "signed off by finance",
    });
    expect(edited.body.outcome, JSON.stringify(edited.body.fieldErrors)).toBe("ok");
    expect(repository.get("acme", id)?.expediteReason).toBe("signed off by finance");
  });

  it("does not hide a note the order already has, which an edit would erase", async () => {
    // `validDraft` is labelled retail, not hazmat, and carries a note — a
    // shape the action accepts and the form would otherwise refuse to draw.
    // A field that is not drawn is not submitted, and `update` reads an absent
    // note as one the user cleared: opening the edit screen and saving would
    // delete it without anyone typing. A condition may hide a field; it may not
    // delete a record.
    const created = await post("orders.create", validDraft);
    const id = created.body.navigate.params["id"] ?? "";

    const form = JSON.stringify((await screen("orders.edit", `?id=${id}`)).body.ui);
    expect(form).toContain(validDraft.notes);
    expect(form).not.toContain('"visibleWhen":{"field":"tags","oneOf":["hazmat"]}');

    const edited = await post("orders.update", { ...validDraft, id });
    expect(edited.body.outcome, JSON.stringify(edited.body.fieldErrors)).toBe("ok");
    expect(repository.get("acme", id)?.notes).toBe(validDraft.notes);
  });

  it("refuses a reason that is not text", async () => {
    // `text()` answers "" for a number, so without a type check `42` would be
    // stored as no reason at all and nobody told.
    const response = await post("orders.create", { ...validDraft, expediteReason: 42 });
    expect(response.body.outcome).toBe("validation");
    expect(response.body.fieldErrors["expediteReason"]).toBeDefined();
  });
});

describe("attaching a document", () => {
  // The question this answers is protocol-level: can bytes cross the hub at
  // all? `FileUpload` was in the catalog from the start and rendered an input
  // that had nowhere to send what it collected.
  async function attach(fields: Record<string, string | Blob>, auth = WRITE) {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);

    const response = await fetch(`${baseUrl}/portal/actions/orders.attach`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}` },
      body: form,
    });
    return { status: response.status, body: (await response.json()) as Body };
  }

  const pdf = () =>
    new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "po-1001.pdf", {
      type: "application/pdf",
    });

  it("records what was attached, and to which order", async () => {
    const response = await attach({ id: "ord-1001", document: pdf() });

    expect(response.body.outcome).toBe("ok");
    expect(repository.get("acme", "ord-1001")?.attachment).toMatchObject({
      filename: "po-1001.pdf",
      contentType: "application/pdf",
    });
  });

  it("needs a document, and says which field", async () => {
    const response = await attach({ id: "ord-1001" });
    expect(response.body.outcome).toBe("validation");
    expect(response.body.fieldErrors["document"]).toMatch(/choose a document/i);
  });

  it("refuses an empty file rather than recording a zero-byte attachment", async () => {
    // A file input can produce one, and storing it would report a document
    // that is not there.
    const empty = new File([], "empty.pdf", { type: "application/pdf" });
    expect((await attach({ id: "ord-1001", document: empty })).body.outcome).toBe("validation");
  });

  it("will not attach to another tenant's order", async () => {
    expect((await attach({ id: "ord-2001", document: pdf() })).status).toBe(404);
    expect(repository.get("globex", "ord-2001")?.attachment).toBeUndefined();
  });

  it("needs the write scope", async () => {
    expect((await attach({ id: "ord-1001", document: pdf() }, READ_ONLY)).status).toBe(403);
  });

  it("refuses a type the screen never said it accepts", async () => {
    // `accept` travels in the screen, so a browser honours it and anything
    // that is not a browser ignores it. Enforced where the bytes land or not
    // enforced at all.
    const script = new File([new Uint8Array([0x3c, 0x3f])], "invoice.svg", {
      type: "image/svg+xml",
    });
    const response = await attach({ id: "ord-1001", document: script });

    expect(response.body.outcome).toBe("validation");
    expect(repository.get("acme", "ord-1001")?.attachment?.filename).not.toBe("invoice.svg");
  });

  it("stores a filename stripped of everything a path or a header could use", async () => {
    // The name arrives in a `Content-Disposition` the uploader wrote. What is
    // stored here is what a real satellite would use as an object-storage key.
    const nasty = new File([new Uint8Array([0x25])], "../../../etc/pa\u0000ss\r\nwd.pdf", {
      type: "application/pdf",
    });
    await attach({ id: "ord-1003", document: nasty });

    const stored = repository.get("acme", "ord-1003")?.attachment?.filename ?? "";
    expect(stored).toBe("passwd.pdf");
    expect(stored).not.toMatch(/[\u0000-\u001f]/);
    expect(stored).not.toContain("/");
    expect(stored).not.toContain("..");
  });

  it("keeps a filename to a length something could actually store", async () => {
    const long = new File([new Uint8Array([0x25])], `${"a".repeat(5000)}.pdf`, {
      type: "application/pdf",
    });
    await attach({ id: "ord-1001", document: long });

    expect(
      (repository.get("acme", "ord-1001")?.attachment?.filename ?? "").length,
    ).toBeLessThanOrEqual(120);
  });

  it("accepts one on a shipped order, unlike an edit", async () => {
    // A delivery note arrives after the thing has shipped, which is the point
    // of a delivery note.
    const response = await attach({ id: "ord-1002", document: pdf() });
    expect(response.body.outcome).toBe("ok");
  });
});
