import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screenRead, type Principal } from "@portal/identity";
import { auditConfig, auditKeyFor, auditStamp, recordAudit, resetAuditConfig } from "./audit";

/**
 * The audit is mandatory, and this is where that is true rather than intended.
 *
 * In the integration tier because it writes files, and `vitest.config.ts`
 * defines the unit tier as touching no filesystem. A suite that quietly ignores
 * the boundary its own config draws makes the boundary meaningless for
 * everyone.
 */

const principal = (tenantId: string): Principal => ({
  sub: `someone@${tenantId}.example`,
  tenantId,
  audience: "internal",
  scopes: [],
});

const original = { ...process.env };
let logPath: string;

beforeEach(() => {
  resetAuditConfig();
  logPath = join(mkdtempSync(join(tmpdir(), "portal-audit-")), "audit.jsonl");
  process.env["PORTAL_AUDIT_KEY"] = "root-secret";
  process.env["PORTAL_AUDIT_LOG"] = logPath;
});

afterEach(() => {
  process.env = { ...original };
  resetAuditConfig();
});

describe("configuration", () => {
  it("refuses to run without a key", () => {
    // A default key produces a log that looks keyed and is not, which is worse
    // than refusing, because it looks like success.
    delete process.env["PORTAL_AUDIT_KEY"];
    resetAuditConfig();
    expect(() => auditConfig()).toThrow(/PORTAL_AUDIT_KEY is required/);
  });

  it("refuses to run without somewhere to write", () => {
    delete process.env["PORTAL_AUDIT_LOG"];
    resetAuditConfig();
    expect(() => auditConfig()).toThrow(/PORTAL_AUDIT_LOG is required/);
  });

  it("says there is no unkeyed mode, because there is not", () => {
    delete process.env["PORTAL_AUDIT_KEY"];
    resetAuditConfig();
    expect(() => auditConfig()).toThrow(/no unkeyed mode/i);
  });
});

describe("the per-tenant key", () => {
  it("differs between tenants under one root secret", () => {
    expect(auditKeyFor(principal("acme"))).not.toEqual(auditKeyFor(principal("globex")));
  });
});

describe("writing", () => {
  const event = (tenantId: string) =>
    screenRead({
      ...auditStamp(),
      principal: principal(tenantId),
      auditKey: auditKeyFor(principal(tenantId)),
      satelliteId: "orders",
      screenId: "orders.list",
      params: { id: "ord-1001" },
      outcome: { status: "ok" },
      latencyMs: 4,
    });

  it("appends one JSON object per line", async () => {
    await recordAudit(event("acme"));
    await recordAudit(event("acme"));

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).action.kind).toBe("screen.read");
  });

  it("never writes the parameters themselves", async () => {
    // The whole reason a digest exists. `ord-1001` is the regulated part.
    await recordAudit(event("acme"));
    expect(readFileSync(logPath, "utf8")).not.toContain("ord-1001");
  });

  it("gives two tenants different digests for the same request", async () => {
    await recordAudit(event("acme"));
    await recordAudit(event("globex"));

    const [acme, globex] = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).action.paramsDigest as string);
    expect(acme).not.toBe(globex);
  });

  it("refuses a record that does not satisfy the schema", async () => {
    // Finding that out at collection time rather than at write time is finding
    // it out too late: the record is the evidence.
    await expect(
      recordAudit({ id: "x", at: "not-a-date" } as never),
    ).rejects.toThrow(/does not satisfy the schema/);
  });

  it("fails closed when it cannot write", async () => {
    // The posture that makes "mandatory" mean something. A system that carries
    // on when it cannot record what it did has a log that is evidence of
    // nothing.
    process.env["PORTAL_AUDIT_LOG"] = join(logPath, "not-a-directory", "audit.jsonl");
    resetAuditConfig();
    await expect(recordAudit(event("acme"))).rejects.toThrow();
  });
});

describe("a write that fails mid-turn", () => {
  it("surfaces as a rejection rather than taking the process with it", async () => {
    // The bug this pins: audit writes were started inside a synchronous
    // callback and only awaited a model round trip later, so a failing write
    // was an unhandled rejection — and Node's default is to exit. "Fail closed"
    // became "crash the container", which is not the same thing at all.
    const failing = join(logPath, "not-a-directory", "audit.jsonl");
    process.env["PORTAL_AUDIT_LOG"] = failing;
    resetAuditConfig();

    const started: Promise<void>[] = [];
    let failure: unknown;

    // The shape the invoker uses: catch attached at push time, rethrown later.
    started.push(
      recordAudit(
        screenRead({
          ...auditStamp(),
          principal: principal("acme"),
          auditKey: auditKeyFor(principal("acme")),
          satelliteId: "orders",
          screenId: "orders.list",
          params: {},
          outcome: { status: "ok" },
          latencyMs: 1,
        }),
      ).catch((error: unknown) => {
        failure = error;
      }),
    );

    // A turn's worth of other work happening before anything is awaited.
    await new Promise((resolve) => setTimeout(resolve, 10));

    await Promise.all(started);
    expect(failure).toBeInstanceOf(Error);
  });
});
