# MCP→PUP generation: a tools-only satellite gets generated screens

PLAN.md's roadmap (M3, item 14) names this gap explicitly: "MCP→PUP
generation — a tools-only satellite gets generated screens." Every other
projection already tolerates a satellite that ships an MCP server but no PUP
declaration — it reaches the agent (`shimTools`/`adoptMcpTools`) and the
outward MCP server fine. Only the deterministic portal cannot: a satellite
manifest with `screens: []` is already schema-legal
(`packages/protocol/src/manifest.ts:210`), but nothing generates anything to
render there, so a tools-only satellite is invisible on the one surface every
other satellite gets by default. PLAN.md's own quality bar for this direction
is explicit and modest: "Adequate — enough to onboard without UI work"
(PLAN.md line 70), not full CRUD parity.

**v1 covers read-only tools only.** Write tools stay reachable via the agent
and outward MCP; generating a form from an arbitrary JSON Schema (nested
objects, `oneOf`, a synthesized confirmation flow) is a separate, much larger
problem this does not take on.

This was green-field when this work started — no partial implementation
existed, and no fixture satellite declared zero screens.

## Key design decision: where generation happens (and where it must not)

Two existing call sites both call `SatelliteClient.fetchManifest()`
(`packages/registry/src/client.ts:143`) and would naively both see any
screens added to a manifest's `screens` array:

- `apps/hub/src/app/[satelliteId]/[[...screen]]/page.tsx` and
  `apps/hub/src/components/SolutionStatus.tsx` / `apps/hub/src/lib/overview.ts`
  — the deterministic-portal path. **This is where generated screens should
  appear.**
- `apps/hub/src/lib/agent.ts`'s `buildAgentSurface` — feeds
  `manifest.screens` into `shimTools` to build agent read-tools, *and*
  separately calls `listSatelliteTools` directly for the same satellite's raw
  MCP tools when `mcpUrl` is set. **If a generated screen were injected into
  the manifest this function sees, `shimTools` would mint a second read-tool
  for the same capability already adopted from `mcpTools`, and the
  collision-drop rule (PLAN.md line 435, `names.ts`'s `indexToolNames`) would
  then silently drop *both* — including the legitimate one.**

So the fix must not touch `SatelliteClient.fetchManifest()` itself (used by
`buildAgentSurface`), nor `packages/registry` at all — which also sidesteps a
real layering problem: `@portal/registry` cannot depend on
`@portal/mcp-gateway` (the dependency runs the other way,
`packages/mcp-gateway/package.json`), so the MCP client pool
(`listSatelliteTools`/`callSatelliteTool`) is simply not reachable from inside
`SatelliteClient` without a circular package dependency.

Instead, generation is composed one level up, in `apps/hub` (which already
depends on both `@portal/registry` and `@portal/mcp-gateway`), and wired only
into the two portal-rendering call sites. `apps/hub/src/lib/overview.ts`
already defines the exact narrow interface needed (`OverviewSource`:
`fetchManifest` / `checkHealth` / `fetchScreen`, `overview.ts:56-63`) and
`SolutionStatus.tsx` already wires a `SatelliteClient` into it
(`SolutionStatus.tsx:31-37`) — `page.tsx` uses the same two methods directly.
One wrapper satisfying that shape, used at both sites, is the whole
integration surface; `SatelliteClient`, `buildAgentSurface`, `publicApi.ts`,
and the action routes are untouched.

A useful side effect: because `page.tsx`'s existing audit call
(`recordAudit(screenRead(...))`, `page.tsx:126-137`) runs after whichever
`fetchScreen`-shaped call resolved the screen, and doesn't care which path
produced the `Result<ScreenResponse>`, generated-screen reads are audited for
free — no new audit call site is needed.

## Design

### 1. The generator — `packages/mcp-gateway/src/generate.ts`

Mirrors `shim.ts`'s structure and conventions (same file family, same
skip-with-reason discipline) but runs the opposite direction: MCP tool →
`ScreenDescriptor`, and tool-call result → `ScreenResponse`.

**`generateScreens(satellite, tools)`**
- Considers only `tool.readOnly === true` tools (write tools are simply not
  candidates in v1 — not a "skip", just out of scope).
- **Screen id**: sanitizes `tool.name` into the `IdSchema` shape
  (`^[a-z0-9]+(?:[.\-_][a-z0-9]+)*$`) — lower-cases and collapses every run of
  disallowed characters (including `-`/`_`) to a single `.`, then trims
  leading/trailing separators. Two names that sanitize to the same id (e.g.
  `orders.search` and `Orders_Search`) are a collision: both are skipped, the
  same "keeping the first would be arbitrary" rule `names.ts` applies to
  projected tool names, applied here in the per-satellite screen-id space
  instead (routes already namespace by satellite, so no cross-satellite
  dotting is needed).
- **Params**: parses `tool.inputSchema` (a JSON Schema object). Only
  top-level properties typed `string`/`number`/`integer`/`boolean` become a
  `ScreenParamSchema` entry — screen params are always strings in a query
  string (`packages/protocol/src/manifest.ts:50-56`), the same ceiling
  `shim.ts` already assumes in the forward direction. A **required** property
  that isn't a flat scalar makes the tool un-generatable (skip with reason,
  mirroring `shim.ts:151-160`'s required-file-param skip); an **optional**
  non-flat property is just never populated when the tool is called.
- **Audience**: `combine([satelliteLayer(satellite), declared])` where
  `declared` defaults to `["internal"]` unless the registry's `toolPolicy`
  says otherwise — the exact computation `adopt.ts:69-73` already runs for
  this same tool's agent/outward-MCP audience, so a capability is entitled
  identically regardless of which projection exposes it.
- Returns `{ screens: GeneratedScreen[], skipped: SkippedGeneratedScreen[] }`,
  where `GeneratedScreen = { descriptor, tool }` — the retained tool is what a
  later call needs to invoke it and coerce its params.

**`coerceGeneratedScreenParams(tool, params)`** — a screen param arrives from
the browser as a string (it came through a query string); this looks up each
name's declared type in `tool.inputSchema` and coerces `number`/`integer`
back with `Number(...)` and `boolean` back with `value === "true"` before the
value is sent to `callSatelliteTool` — otherwise the satellite's own MCP
input validation rejects a string where its schema says `number`.

**`buildGeneratedScreenResponse(generated, outcome)`** — the inverse of
`extract.ts`'s `extractData` (data → `UiNode`, not `UiNode` → data):
- `structuredContent` is always an object at the top level (MCP does not
  allow a bare array there), so a "list of things" tool nests its rows in a
  property (`{ matches: [...] }`). The first array-of-objects property found,
  by key order, is taken as the rows and rendered as a `Table`.
- Columns come from the tool's declared `outputSchema` when available (see
  below); if absent, they fall back to the union of keys across the first
  page of returned rows.
- No array-of-objects property, but a non-empty flat object → `KeyValueList`.
- Neither → falls back to a single `Text` node wrapping the tool's plain-text
  `content`, so a satellite that declares no `outputSchema` still produces
  *something*, consistent with "Adequate," not a hard requirement on the
  satellite author.
- Rows are capped at `MAX_EXTRACTED_ROWS` (reused from `extract.ts` — one cap
  value for both directions), and truncation is surfaced as an extra `Text`
  node above the table rather than cut silently, mirroring PLAN.md's existing
  rule that "a read tool caps the rows it returns and says that it did"
  (PLAN.md line 436).
- The built node is run through `validateNested` (`@portal/catalog`, now a
  new dependency of `packages/mcp-gateway`) before being returned; a failure
  throws rather than returning a `Result`, because the only way it *can* fail
  is a bug in this generator — a satellite's row values can be anything
  (`Table.rows` accepts them unread) — so it should be as loud as any other
  invariant violation, not quietly degrade.
- No `source` field is set on `Table`/`KeyValueList` — that field exists for
  agent-composed screens to cite a tool call for grounding; this path is the
  hub authoring a screen directly, the same status a satellite's own PUP
  response has, so grounding doesn't apply.

### 2. `packages/mcp-gateway/src/client.ts` — stop discarding `outputSchema`

`SatelliteMcpTool` discarded the MCP SDK tool's `outputSchema` on discovery
even though `apps/satellite-orders/src/mcp.ts` declares one. Added
`readonly outputSchema?: Record<string, unknown>` to the interface and mapped
it through. Without this, a generated screen would have no column names
until a call had actually returned at least one row — an empty result set
would be unrenderable.

### 3. The composition wrapper — `apps/hub/src/lib/portal.ts`

A second factory alongside `clientFor`, `screenSourceFor(satellite)`,
returning an object shaped like `OverviewSource` (`fetchManifest` /
`fetchScreen` / `checkHealth`):

- `checkHealth`: pure passthrough to `clientFor(satellite).checkHealth`.
- `fetchManifest()`: delegates to `clientFor(satellite).fetchManifest()`. If
  `ok` and `value.screens.length === 0` and `satellite.mcpUrl !== undefined`,
  calls `listSatelliteTools` + `generateScreens` and returns the manifest with
  `screens` replaced by the generated descriptors; otherwise passes the real
  manifest through unchanged. Gating strictly on `screens.length === 0` keeps
  this to the literal "tools-only satellite" case the milestone names — a
  satellite with both real screens and an MCP server is out of scope for v1,
  and this also avoids any same-satellite id collision between a declared
  screen and a generated one.
- `fetchScreen(screenId, params, principal)`: in the same generated case,
  re-derives the tool list and re-runs `generateScreens` (no cross-call
  caching — see Known limits), finds the `GeneratedScreen` matching
  `screenId`, coerces params via `coerceGeneratedScreenParams`, calls
  `callSatelliteTool`, and returns `buildGeneratedScreenResponse(...)`
  wrapped in the same `Result<T>` shape `SatelliteClient` uses. Otherwise
  delegates to `clientFor(satellite).fetchScreen(...)` unchanged.

`page.tsx` and `SolutionStatus.tsx` swap `portal.clientFor(satellite)` for
`portal.screenSourceFor(satellite)`. No other change to either file — both
already only touch `fetchManifest`/`fetchScreen` (`SolutionStatus.tsx` also
`checkHealth`), so the existing audience filter, default-screen selection,
error rendering, and audit call all apply to generated screens automatically
because they operate on whatever `manifest.value.screens` contains, not on
how it got there.

`apps/hub/src/lib/agent.ts`, `apps/hub/src/lib/publicApi.ts`, and the action
routes keep calling `clientFor` directly — untouched.

## Known limits

- **No generated forms.** Write tools are agent/outward-MCP-only in v1; a
  generic JSON-Schema-to-form-plus-confirmation generator is deferred.
- **No inter-screen navigation is generated.** If a tools-only satellite has
  more than one eligible read tool, each gets its own routable screen, but
  only the first (by discovery order) is the satellite's default landing
  screen at `/{satelliteId}` — nothing links the others from it. The catalog
  already has what's needed to fix this cheaply (`Link` with `screenId`,
  `packages/catalog/src/components.ts:333-343`) but it isn't built here.
- **`fetchScreen` re-lists tools on every request** rather than reusing what
  `fetchManifest` just fetched — two `listTools` round-trips per generated
  screen view. Same pragmatic tradeoff PLAN.md already accepts for the
  composed home screen ("no cache... slow and billable per view... the fix is
  not built") rather than introducing request-scoped memoization here.
- **Conformance doesn't cover this.** `pnpm conformance` probes a satellite's
  own HTTP surface; a tools-only satellite has no PUP endpoint for it to
  check.
- **A tool with a required non-flat-scalar input, or a name that sanitizes to
  an empty/colliding screen id, is silently excluded** (skip-with-reason,
  logged the way `shim.ts` already logs its own skips) rather than partially
  represented.
- **A tool whose result has more than one array-of-objects property** gets
  only the first, by key order — a case v1 does not pick between more
  carefully.

## Files touched

- `packages/mcp-gateway/src/generate.ts` (new)
- `packages/mcp-gateway/src/generate.test.ts` (new, unit)
- `packages/mcp-gateway/src/client.ts` (edit: `outputSchema` field)
- `apps/satellite-orders/src/mcp.integration.test.ts` (edit: asserts
  `outputSchema` survives discovery through the real gateway client)
- `packages/mcp-gateway/src/index.ts` (edit: re-exports)
- `packages/mcp-gateway/package.json`, `tsconfig.json` (edit: add
  `@portal/catalog` dependency/reference)
- `apps/hub/src/lib/portal.ts` (edit: `screenSourceFor`)
- `apps/hub/src/app/[satelliteId]/[[...screen]]/page.tsx` (edit: one call site)
- `apps/hub/src/components/SolutionStatus.tsx` (edit: one call site)
- `PLAN.md` (edit: mark item 14 done, add the "Known limits" bullets above,
  in that section's existing voice)

## Verification

- `pnpm --filter @portal/mcp-gateway test` — `generate.test.ts` unit coverage.
- `pnpm test:integration` — a hub-level integration test standing up a
  minimal fixture MCP server (can reuse `apps/satellite-orders/src/mcp.ts`'s
  pattern with a manifest overridden to `screens: []`) and asserting
  `screenSourceFor` produces a working screen end to end: manifest lists the
  generated screen, `fetchScreen` returns a valid `ScreenResponse`, and an
  ineligible tool (required nested-object input) is absent with a logged skip
  reason.
- Manual: `pnpm up`, point a temporary tools-only manifest at one satellite,
  visit `/{satelliteId}` in the browser, confirm the generated table/
  key-value screen renders, the audit log gains a `screenRead` entry for it,
  and an unauthenticated/wrong-tenant request is refused by the satellite's
  own MCP handler exactly as a real screen would be.
- `pnpm typecheck` and `pnpm --filter @portal/hub build` (the hub's `noEmit`
  typecheck doesn't cover server/client boundary bugs — the build does).
- `pnpm verify:ci` before opening the PR.

## Status

Done: the generator (`generate.ts`) with unit tests, and the `outputSchema`
restoration on `SatelliteMcpTool` with an integration assertion.

Remaining: the `apps/hub/src/lib/portal.ts` wrapper, wiring `page.tsx` and
`SolutionStatus.tsx` to it, a hub-level integration test against a fixture
tools-only satellite, and the PLAN.md update marking item 14 done.
