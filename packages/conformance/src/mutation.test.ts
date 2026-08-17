import { CURRENT_PROTOCOL_VERSION } from "@portal/protocol";
import { describe, expect, it } from "vitest";
import { runConformance } from "./checks";

/**
 * The check that guards the tenancy model, held to a satellite that does not
 * guard it.
 *
 * Independent of the suite the review added: this builds a satellite with no
 * audience enforcement whatsoever and asserts the kit does not award it the
 * tick. Before the baseline probe it did, because a missing scope answers 403
 * exactly as a wrong audience does — and the default probe carries no scopes,
 * so that was every first run.
 */
const manifest = {
  protocol: CURRENT_PROTOCOL_VERSION,
  satelliteId: "lax",
  displayName: "Lax",
  audience: ["internal"],
  screens: [{ id: "lax.list", title: "List", audience: ["internal"] }],
  actions: [],
};

/** Refuses everything with 403, and never looks at an audience. */
const noAudienceCheck = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.pathname === "/portal/manifest") return new Response(JSON.stringify(manifest));
  return new Response("{}", { status: 403 });
}) as typeof fetch;

/** Enforces audience properly: accepts internal, refuses external. */
const enforces = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.pathname === "/portal/manifest") return new Response(JSON.stringify(manifest));

  const auth = (init?.headers as Record<string, string> | undefined)?.["authorization"];
  if (auth === undefined) return new Response("{}", { status: 401 });

  let claims: { audience?: string };
  try {
    const payload = auth.replace("Bearer ", "").split(".")[0] ?? "";
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof claims;
  } catch {
    return new Response("{}", { status: 401 });
  }

  if (claims.audience !== "internal") return new Response("{}", { status: 403 });
  return new Response(
    JSON.stringify({
      protocol: CURRENT_PROTOCOL_VERSION,
      screen: { id: "lax.list", title: "List" },
      ui: { type: "Page", children: [{ type: "Text", props: { text: "hi" } }] },
    }),
  );
}) as typeof fetch;

const audienceCheck = async (fetchImpl: typeof fetch) => {
  const report = await runConformance({
    baseUrl: "http://sat.test",
    principalSecret: "s",
    fetch: fetchImpl,
  });
  return report.results.find((r) => r.name === "refuses an undeclared audience")?.status;
};

describe("the audience claim", () => {
  it("is not awarded to a satellite that refuses everyone equally", async () => {
    expect(await audienceCheck(noAudienceCheck)).toBe("skip");
  });

  it("is awarded to one that actually distinguishes", async () => {
    // The other half: a check that never passes is as useless as one that
    // always does.
    expect(await audienceCheck(enforces)).toBe("pass");
  });
});
