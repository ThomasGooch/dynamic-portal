# Dynamic Portal — A Capability Platform with Screen, Agent, and API Projections

## Context

The organization runs numerous independently-deployed solutions, each with its own UI. Users have no single entry point, branding is inconsistent, and a prior micro-frontend effort failed here — so **MFE is off the table**: no Module Federation, no single-spa, no runtime loading of satellite JavaScript into the hub.

The hub is a **lightweight renderer**, not a collection of hand-built UIs:

- **Satellites** declare *what* to display and own that declaration's maintenance.
- **The hub** owns *how it looks* — all CSS, design tokens, branding, shell, nav, auth — plus a registry of satellites.
- Adding or changing a satellite screen requires **zero hub deployments**.

Shopify Admin UI Extensions and Stripe Apps use this shape. Stripe constrains extension authors to a component library plus design tokens — `Box`/`Inline` accept a `css` prop, but with a proprietary layout system, token-only spacing and color, and no arbitrary font faces. Our rule is stricter (no style surface at all) because our satellites are first-party: they send **data, not code**, which removes the isolation layer that sank the MFE attempt.

**Leadership's ask is broader than a portal:** a durable way to interact with every solution — for internal users *and* external clients — across AI, MCP, and API surfaces, that stays maintainable and extendable for 5+ years.

**Confirmed decisions:** React + TypeScript hub · hub proxies all satellite traffic · satellite UIs are tables/lists/search, forms/CRUD/workflows, dashboards/charts (no bespoke canvas/map/editor UIs, which is what makes a fixed vocabulary viable) · agent does the full loop **including governed writes** · hub is **also an outward MCP server** · third-party SaaS MCP servers in scope · agent-composed home screen · **external clients use the shared portal under our branding, plus a brokered programmatic surface** · **PUP and MCP stay internal contracts — we broker all external access** · **dedicated platform team owns the hub and catalog** · **regulated data in scope**.

---

## The durability thesis — what this is a bet on

Architectures don't die of old technology. They die of coupling to things that change faster than they can. So the 5-year question is: *what has this design bet on, and how fast does each bet decay?*

| Layer | Realistic half-life | Replaceable without satellite teams changing a line? |
|---|---|---|
| **Capability declarations** (a solution's screens, actions, data shapes) | 10+ yrs — a domain artifact, not a tech one | **This is the asset.** Everything else renders it |
| **Tenancy / authorization / audit model** | Permanent in practice | **No — design as if unchangeable** |
| Catalog vocabulary | 5–10 yrs, additive-only | Yes, versioned |
| PUP protocol | 5–10 yrs | Yes, N-2 support |
| Public API contract | 3–5 yrs per major version | Yes — deliberately decoupled from the catalog |
| MCP wire version | 3–5 yrs (MCP is ~2 yrs old; it will churn) | Yes — the gateway absorbs it |
| Renderer (hub-owned, ~34 components) | 3–5 yrs | Yes — the catalog is the contract, not the code |
| UI framework (React) | 5–8 yrs | Yes, but expensively |
| Model | 6–18 months | Trivially |

**The rule the architecture must hold to:** *every fast-decaying dependency sits behind a seam owned by the platform team, and no satellite ever imports one.* A 2029 rewrite of the hub then costs weeks, not a program, because the declarations don't move.

**Two structural properties that make this more than aspiration:**

1. **The declaration cannot rot separately from the product, because it *is* the product's UI.** Unlike a service catalog, API docs, or an integration registry, there is no second artifact to drift. A satellite team that stops maintaining its declaration has stopped shipping UI — the incentive is self-enforcing. This is the single biggest reason to prefer this over a documentation-based or gateway-based integration strategy.
2. **Two independent contracts, evolving at different speeds.** The internal catalog stays evolvable by fiat *because* external parties never touch it. The public API absorbs the contractual burden. Coupling those two — publishing PUP as the partner contract — would freeze the vocabulary permanently, and is the mistake to avoid.

---

## Architecture — one declaration, four projections

Leadership asked for "AI / MCP / API." Those are not three systems. They are three projections of one asset, and the screens are a fourth.

```
                    ┌──────────────────────────────┐
                    │   SATELLITE DECLARATIONS      │  ← the durable asset
                    │   screens · actions · tools   │
                    └──────────────┬───────────────┘
                                   │
        ┌──────────────┬───────────┼───────────┬──────────────┐
        ▼              ▼           ▼           ▼              ▼
   Screens        Agent tools  Outward MCP  Public API   (2029: whatever
   (int + ext,    (internal    (external    (brokered,    replaces chat)
    our brand)     agent)       agents)      versioned)
```

A new projection in 2029 is one addition inside the hub — not 20 integration projects. Every projection is derived from, and constrained by, the same declaration.

**Bidirectional generation, so every solution enters through the door it already has:**

| Satellite has | Gets generated | Fidelity |
|---|---|---|
| PUP only | MCP tools (screens→read, actions→write) | Good — semantic components carry structure. A read returns the screen's *data* (table rows, stat values, chart series), not its UI tree: sending the tree would spend most of a model's context on layout it cannot use, and only declared columns survive, so presentation fields the satellite sent for the renderer never reach the model |
| MCP only | PUP screens (tools→generated CRUD/search UI) | Adequate — enough to onboard without UI work |
| Both | Nothing generated; both hand-authored | Best |

This is the extendability answer: **the marginal cost of solution #20 must equal solution #3.** Target metric — time-to-first-screen for a new satellite under one day using the SDK, and hub deploys required per satellite change: zero.

### Runtime topology

```
Internal users ─┐                     ┌─► PUP proxy ──────► satellite screens/actions
External users ─┼─► HUB (Next.js) ────┼─► MCP client gateway ─► satellite MCP servers
External agents ┤    Shell·Renderer   │
Partner systems ┘    Agent·Registry   └─► Public API façade
                     Identity·Audit
```

The browser never learns a satellite exists beyond its ID; satellites stay internal — no CORS, no public ingress, no browser-facing auth.

### Three modes, one hard rule

| Mode | What it is | Traffic |
|---|---|---|
| **Deterministic** | Satellite-authored screens. No model involved. | Most |
| **Assisted** | Agent acts on the screen you're looking at. | Some |
| **Generative** | Agent composes a novel cross-satellite screen. | Least |

**Rule: mode 1 must work with the agent switched off**, per tenant as well as globally. The agent is strictly additive, never load-bearing — an availability property, a compliance control, and a cost control at once.

---

## Tenancy, authorization, and audit — the part you cannot refactor later

With regulated data and external users in the same portal, this outranks every technology choice. Get it wrong and no amount of clean layering saves you.

**The narrowing rule lives in one function, after six attempts at living in six.** Every projection answers the same question — given a satellite, something declared inside it, and possibly a registry policy about that thing, may this principal have it? Audience *narrows* (the effective audience is the intersection of every enclosing layer, so an inner declaration can never widen an outer one) and scopes *accumulate* (the union, because an inner policy adds a demand and never relieves the caller of an outer one). Stated that way it is obvious; applied at call sites it was wrong in the protocol's screen check, the registry's tool check, the hub's per-screen enforcement, the manifest-versus-registry check, the MCP gateway, and the public façade. Every one was found by review rather than by construction, and every fix was local, which is exactly why there was always a next one. `entitle()` in `@portal/registry` is the rule; a cross-projection test in the hub is the guard, so a seventh projection written without it fails there rather than in an audit.

**Principle: the hub authenticates; satellites authorize.** The hub establishes the principal (user, tenant, audience, scopes) and propagates it via RFC 8693 token exchange. **Every satellite independently enforces tenant scoping on every call.** The hub must not become the policy engine.

This is deliberately redundant, and the redundancy is the point: if authorization lived only in the hub, a single hub bug would be a cross-tenant data breach across every solution simultaneously. With enforcement in satellites, a hub bug is an availability incident, not a disclosure incident. Satellites also stay independently correct when called directly — which they will be, during incidents and migrations.

**The registry gains an audience dimension, default-deny.** Every satellite, screen, and tool declares `audience: [internal] | [internal, external]`. Nothing is externally visible unless explicitly marked. The public API façade projects only the external-marked subset.

**Two parties have to agree, and building it made that concrete.** The registry names a thing publicly — `orders.list` becomes the resource `orders` under the service `order-management` — and the satellite's own manifest marks the screen external. Either alone publishes nothing. The mapping is what makes "versioned independently" more than a sentence: without it the public contract *is* the screen ids, and a satellite team renaming one breaks every partner. Public names are lower-kebab where internal ids are dotted, so the two namespaces cannot quietly converge, and a public service name is unique across the whole registry because that namespace is flat and, once published, permanent.

What crosses the boundary is records and a summary, never a UI tree, and never the `ActionResponse` envelope — `patch` and `navigate` are instructions to a renderer a partner does not have. The extraction step is shared with the agent path deliberately: "the data on this screen, without the layout" is one question with one right answer.

**Audit is a first-class schema, not a log format.** Append-only, records: principal, tenant, audience, satellite, screen/tool, parameter hash, outcome, latency, and — for agent actions — the complete tool-call chain. This is the artifact a regulator or client security review asks for. Design it in M1; retrofitting audit into a system that already handles regulated data is a re-certification, not a patch.

### The agent's regulated-data path

- **Model choice is a compliance decision.** `claude-opus-5` is zero-data-retention eligible. **Claude Fable 5 / Mythos 5 are not** — they require 30-day retention and reject requests from ZDR orgs outright. Do not reach for the more capable model without checking this first; the plan uses Opus 5 partly for this reason.
- **The gateway is the single choke point where regulated data can reach the model.** Tool results are the only data path in. That makes field-level redaction, minimization, and per-tenant policy enforceable in exactly one place rather than sprayed across satellites.
- **Grounding doubles as the audit trail.** Because every displayed fact must carry `source: {toolCallId}`, the provenance chain answers *"which records did the agent read, for which principal, when"* precisely. A control that exists for correctness pays for itself twice.
- **Per-tenant agent kill switch**, so a client who won't accept AI processing can be served the deterministic portal with no code change. It governs the *surface*, not whose model reaches it — the outward MCP endpoint needs no key of ours and is gated all the same, which is a distinction that had to be made explicit after asking "is our agent configured" left that endpoint open.

---

## Part 1 — The rendering substrate

### The contract: Portal UI Protocol (PUP)

Three endpoints per satellite:

| Endpoint | Purpose |
|---|---|
| `GET /portal/manifest` | Protocol version, nav entries, screen list, MCP endpoint (if any), audience, health |
| `GET /portal/screens/{id}?params` | Returns a `ScreenResponse` — the UI tree |
| `POST /portal/actions/{id}` | Returns an `ActionResponse` — what changed |

**`ActionResponse`** is what makes forms and workflows work with no satellite JS — hypermedia thinking applied to JSON. The satellite responds with *what should now be true*; the hub applies it.

```jsonc
{
  "outcome": "ok" | "error" | "validation",
  "toast":       { "level": "success", "message": "Order approved" },
  "fieldErrors": { "email": "Already in use" },
  "patch":       [ { "targetId": "orders-table", "ui": { ... } } ],
  "navigate":    { "screenId": "orders.detail", "params": { "id": "42" } }
}
```

### Three shapes, two mechanical conversions

| Producer | Format | Reason |
|---|---|---|
| Satellites | **Nested tree** | Readable, diffable, trivial to emit from any language |
| Agent | **Flat element list** — `{root, elements: [{id, type, props, children}]}` | **Structured outputs reject recursive JSON Schemas.** A nested tree cannot be schema-constrained; a flat list can |
| Renderer | **Flat keyed map** — `{root, elements: {id: {...}}}` | Addressable by id, which is what `patch.targetId` needs |

The agent's list form is **ours, not `json-render`'s** — its native format keys elements by id, and a map with arbitrary keys cannot be strict-schema-constrained, because structured outputs require `additionalProperties: false` on every object and don't accept `additionalProperties` as a schema. The adapter indexes the list into the map.

(`json-render` reaches valid specs by prompt-generation plus validation. We do that *and* constrain at the schema layer — a stricter guarantee than the library assumes, and why the grounding rule is enforceable rather than advisory.)

### Component vocabulary v1 — 34 components

- **Layout** — `Page` `Section` `Stack` `Grid` `Card` `Tabs` `Divider` `Modal`
- **Display** — `Heading` `Text` `Badge` `StatTile` `KeyValueList` `Table` `Chart` `Alert` `EmptyState` `Timeline`
- **Input** — `Form` `TextField` `TextArea` `NumberField` `Select` `MultiSelect` `DateField` `DateRange` `Checkbox` `Switch` `RadioGroup` `FileUpload` `Hidden`
- **Action** — `Button` `Link` `MenuButton`

Producers set semantic props only (`variant: "danger"`, `tone: "muted"`). **No className, no style, no raw HTML.**

`Table` may carry inline `rows` or a `dataSource` screen ID; paging/sort/filter are hub-rendered and re-fetch through the proxy.

### Trust boundary

Every producer's output is validated against the catalog schema **before it reaches the browser**. Unknown node types and props are rejected or degraded to a visible placeholder. `Link` targets are allowlisted to registered satellites. A compromised satellite cannot inject markup, scripts, or styling into the shell.

**What this does not stop:** a compromised satellite still controls all *text* in its screens, rendered inside a trusted branded shell carrying the hub's authority — arguably a better phishing surface than an iframe, which at least looks foreign. Schema validation is an integrity boundary, not a content-trust boundary. The honest statement to a security reviewer is "we contain code injection, not content injection"; the mitigations are that satellites are first-party, deployed through the same pipeline, and every served response is audited.

---

## Part 2 — MCP integration

### Standards position: borrow the structure, deliberately fork the substrate

**MCP Apps (SEP-1865, extension id `io.modelcontextprotocol/ui`, published 2026-01-26)** standardizes `ui://` resources, tool→UI linkage via `_meta.ui.resourceUri`, capability negotiation, and JSON-RPC over `postMessage`. Its substrate is **sandboxed iframes running server-supplied HTML** — correct for chat clients, wrong for us: per-satellite HTML in iframes is micro-frontends wearing a new hat.

**Be honest about what this costs — the spec does not sanction a custom mime type:**

> "MIME type of the UI content. SHOULD be `text/html;profile=mcp-app` for HTML-based UIs in the initial MVP. Other content types are reserved for future extensions."

"Reserved for future extensions" means reserved for the working group to allocate, not "bring your own," and the capabilities `mimeTypes` array declares support for spec-defined types only. The sandbox rule is content-agnostic:

> "All View content MUST be rendered in sandboxed iframes with restricted permissions."

So rendering `application/vnd.portal.ui+json` natively in-shell is **a deliberate fork for the first-party path, not a compliant extension.** Claim it as such in review.

Grounds for forking anyway:

- Satellites are **first-party**; the iframe mandate contains untrusted third-party *code*, and we send data validated against a closed schema. The threat it mitigates is one we designed out.
- Branding unification is the hub's purpose. Complying defeats the requirement.
- **We stay fully compliant where the threat model applies** — third-party SaaS MCP servers get the real thing: sandboxed double-iframe, CSP from `_meta.ui`, foreign-source chrome.

Borrowed unchanged because it's good design and free: `ui://` naming, `_meta.ui.resourceUri` linkage, and `visibility: ["model","app"]` — which already expresses "agent-invisible" vs "app-only," precisely our governance need.

### The MCP client gateway

We connect to satellite MCP servers **from the hub**, not via the Messages API's `mcp_servers` connector. The connector has Anthropic's servers dial the endpoint directly — requiring public ingress on internal satellites and bypassing our RBAC filtering, namespacing, and audit entirely. Owning the client is the point of a gateway.

Responsibilities: connection pooling · namespacing (`orders.search` vs `fleet.search`) · per-principal RBAC and audience filtering · token exchange · rate limiting · audit · redaction policy · MCP-result → PUP adaptation.

Two durability properties: because we own the client, satellite MCP tools reach the model as **ordinary tool definitions**, so API-level restrictions on connector-supplied MCP tools never apply — and **if MCP is superseded, we replace the gateway, not the satellites.** That is the structural hedge on a two-year-old standard.

### Outward MCP server

The hub exposes its aggregated, RBAC- and audience-filtered tool surface as an MCP server, so Claude Desktop, ChatGPT, or an IDE agent reaches every solution through one governed endpoint. This makes the portal headless-capable and is the org's single agent-facing capability surface.

**An internal contract, like PUP.** Partners are brokered through the public API and never see this; "outward" means outside the hub's own UI, not outside the organization.

**Stateless, one server per request.** No session id, JSON responses, nothing kept between calls — so two replicas share nothing and a restart costs a host a reconnect. The tool surface is rebuilt per request for the same reason the agent's is.

**Governed writes are not listed, and refuse if called by name anyway.** A confirmation is a person being shown what is about to happen in a screen the hub renders; a host cannot render that, and delegating the decision to a client we do not control would leave the hub the choke point on paper only. Listing a tool that always refuses would be worse — it reads as a capability and is a dead end. Instead the server's `instructions` name those actions and say where they are performed, so an agent directs the user to the portal rather than reporting the thing impossible. The consequence, stated plainly: **the outward MCP surface is read-only except for writes a registry policy has explicitly ungoverned.**

---

## Part 3 — The agent

Model: **`claude-opus-5`** via `@anthropic-ai/sdk` (ZDR-eligible — see the regulated-data section), with `thinking: {type: "adaptive"}`; a token budget is rejected outright on this model generation. The vendor sits behind a single interface with one implementation, because the model is the fastest-decaying dependency in the table above.

**The loop is hand-written, and `toolRunner` is deliberately not used.** Its per-turn hooks are the right tool when a loop runs to completion in one process. Ours cannot: a write pauses for a human to approve it, and that pause crosses an HTTP boundary and possibly a container restart. Keeping a runner alive server-side, keyed by a session, would make the hub stateful for exactly the feature most likely to be interrupted. So the conversation *is* the state and it travels with the request — which also makes resuming free, since the loop simply looks for a tool call nobody has answered yet and finds the approved write sitting there.

**Grounding is enforceable, not a prompt plea, and it turned out to be structural.** The agent emits through a `render_screen` tool whose `input_schema` *is* the catalog, projected to JSON Schema — so the API constrains output before our validator runs. Two layers, neither a prompt.

Building it changed the design for the better. `Table.rows` and `Chart.data` are `Record<string, unknown>`, which is an open object no strict schema can close — and they are also precisely what a model must not invent. **They are removed from the schema entirely.** The model composes the table and cites a tool call; the hub fills the rows in from that call's result. A fabricated row is not rejected after the fact, it was never expressible. `StatTile.value` and every `KeyValueList` item are the cases that still need checking, because they are strings the model composes rather than data dropped into a hole: citing a real call proves it looked something up and nothing more, so each value must actually appear in that call's result or the node is refused. That is the difference between a citation and grounding — and `KeyValueList` had no `source` prop at all until this was built, meaning a model could state any figure there while the tile beside it was held to a citation.

Two smaller consequences. Opaque `action.payload` bags are dropped too — a governed write goes through a tool call whose arguments the gateway checks, not through a payload hand-assembled into a button. And `Record<string, string>` params are projected as closed `{key, value}` lists and lowered back, because without them an agent could not link to a specific record, which is most of what cross-satellite composition is for.

**Provenance is always rendered.** Satellite-authored screens read as authoritative; agent-composed ones are visibly derived, with click-through from any number to the tool call behind it; third-party content is marked foreign.

**Governed writes.** The registry declares per tool: `agentVisible`, `requiresConfirmation`, `rbacScopes`, `audience`. **The default differs by what the tool does, and this is the one place the zero-hub-deploy promise deliberately does not apply.** A screen becomes a read tool that is agent-visible without a registry entry — it is already bounded by audience and scopes, the satellite re-checks both, and demanding an entry per screen would mean adding a screen needed a hub deploy after all. An action becomes a write tool that is invisible until the registry names it, because exposing a mutation to a model is a decision a human makes in a reviewed file, not one inherited from a satellite team adding an endpoint. Neither flag is defaulted in the registry schema: defaulting them there would mean a tool listed for some unrelated reason — to add a scope, say — arrived pre-approved with its confirmation cleared. An agent-proposed mutation renders as a hub-styled confirmation card built from the existing `ActionResponse` envelope — approve, execute, audit. No new machinery.

**The promotion loop.** A user asks a question → the agent composes a screen → the user pins it → it becomes a registered view → popular views graduate into a satellite's real PUP screens. This is not only a discovery feature: it is the pressure valve that stops generative UI from becoming permanent infrastructure. Without it, five years of pinned agent views become an expensive, nondeterministic, hard-to-audit shadow portal.

---

## Registry — one file, every surface

```yaml
- id: orders
  displayName: Order Management
  baseUrl: http://localhost:4001        # PUP
  mcpUrl: http://localhost:4001/mcp     # omit → hub generates the shim
  owner: fulfillment-team
  audience: [internal]                  # default-deny; add `external` explicitly
  nav: { section: Operations, order: 10 }
  rbacScopes: [orders.read, orders.write]
  timeoutMs: 3000
  tools:
    orders.approve: { requiresConfirmation: true, rbacScopes: [orders.write] }
    orders.purge:   { agentVisible: false }
    orders.search:  { audience: [internal, external] }
```

Boot: fetch each manifest, validate, build nav, connect MCP. A satellite failing validation is disabled with a loud log — it never breaks the shell. Per-satellite circuit breaker; a dead satellite renders a scoped error card while everything else keeps working.

---

## Operating model — how this survives contact with five years

A dedicated platform team makes this viable; it does not make it automatic. The failure mode for vocabularies is sprawl, and the failure mode for platform teams is becoming the critical path.

**Ownership split.** Platform team owns: catalog, PUP, hub, gateway, SDK, conformance kit, public API façade. Satellite teams own: their declarations, their authorization, their data. Nobody else edits the catalog.

**Catalog evolution rules — write these down on day one:**
- **Additive only.** Components and props are never removed, only deprecated. A five-year-old satellite must still render.
- **Deprecate, never delete.** Deprecated components warn in conformance, render normally in production.
- **A new component needs demand from more than one team.** One team's special case belongs in composition, not vocabulary. This single rule is what prevents 34 components from becoming 200.
- **Satellites declare protocol version; hub supports N-2.** Deprecation windows in quarters, announced in the conformance CLI before they bite.
- **Quarterly vocabulary review** — what's unused, what's overloaded, what three teams have worked around identically.

**Metrics that tell you it's still healthy** (all cheap to instrument, all leading indicators):
- Time-to-first-screen for a new satellite — target < 1 day
- Hub deploys required per satellite UI change — target 0, alert on any
- Catalog request queue age — the platform-team-as-bottleneck early warning
- Share of screens agent-composed vs. authored — rising steeply means the promotion loop is not working
- Conformance pass rate across satellites — declaration rot detector

---

## Local stack and test strategy

**Everything runs locally in Docker.** `pnpm up` builds and starts the stack; `pnpm stack:test` runs the suite inside the same image the services run in, so a green local run and a green containerised run mean the same thing. One parameterised `docker/node-app.Dockerfile` serves every Node service — a new satellite is four lines of compose, not a new Dockerfile. The image installs pnpm explicitly rather than through corepack, which ships with Node only up to v25 and would break the image on the next LTS.

**Three tiers, separated by what they are allowed to touch** — and, more usefully, by *how they fail*:

| Tier | Touches | Catches what the tier below cannot |
|---|---|---|
| **unit** | Pure logic — schemas, validators, tree adapters, version policy | Logic errors, fast, on every save |
| **integration** | A real server on a real port, in-process. No browser | That a satellite enforces its **own** tenant scoping when called directly, with the hub absent. A unit test structurally cannot make this claim |
| **e2e** | The running stack over published ports; browser once the hub exists | The code *as deployed* — image, entrypoint, environment, healthcheck, port mapping. A green integration suite alongside a broken Dockerfile is exactly this gap |

**The verification list in this document is already the e2e plan.** Items 1–16 map nearly one-to-one onto Playwright specs, which is a property worth preserving as the list grows: acceptance criteria written as executable scenarios rather than prose.

**Conformance is tested against the published schemas, not a service's own idea of them.** Every satellite response in the integration and e2e tiers is parsed with `@portal/protocol`'s real schemas, which makes declaration drift a failing build rather than a code review.

**One known shortcut.** Services run TypeScript directly via `tsx`. Node's built-in type stripping cannot do this — it does not rewrite `.js` specifiers to `.ts`, and refuses to strip types inside `node_modules`, which is where workspace packages resolve. Before production, containers should run a `tsc` build output rather than a dev transpiler; the change is contained to the Dockerfile's final stage.

---

## Library choices (reuse over build)

**The SDK is builders and nothing else — no server, no router, no framework.** A satellite is an ordinary HTTP service in whatever stack its team already runs, and the moment this package has an opinion about that it stops being adoptable by the teams that most need it. What it does have is the compiler: `{ type: "Text", props: { txt: "hi" } }` typed as a `UiNode` compiles clean, because `props` is `Record<string, unknown>`; `ui.Text({ txt: "hi" })` does not. `satellite-orders` is written through it, which is both the proof and the example.

| Need | Use |
|---|---|
| JSON-tree renderer | **Ours** — `apps/hub/src/renderer`. See the reversal note below |
| Hub framework | **Next.js App Router** — route handlers give us the BFF proxy with no separate service |
| Components / tokens | **Hand-written CSS + custom properties** — `globals.css` holds the tokens, `renderer.css` the rules. See the reversal note below |
| Agent | **`@anthropic-ai/sdk`**, `claude-opus-5`, adaptive thinking, hand-written loop (see above) |
| MCP | **`@modelcontextprotocol/sdk`** (client + server) + `@modelcontextprotocol/ext-apps` |
| Charts | **Recharts** — the one UI dependency taken. Colours are CSS custom properties, so charts re-theme with everything else |
| Table / forms / fetching | None. Server-rendered tables, uncontrolled form controls read on submit, fetching in server components |

**Reversal — `json-render` and shadcn/Tailwind were both dropped when the renderer was actually built.** Both were reasonable on paper; neither survived contact.

`@json-render/react` (0.20.0, Apache-2.0, three packages, peer React 19) is real and small, and its recursive renderer is the part we needed least — that is roughly 40 lines here. Its substance is a *client state model*: `useStateBinding`, `useBoundProp`, a state store, visibility and validation providers, binding expressions inside the spec. Adopting it usefully would mean putting an expression language into the wire contract, which then has to be understood by the strict agent schema, the public API, and every satellite in whatever language it is written. That is the opposite of the durability thesis: it would make the fastest-decaying dependency in the stack the shape of the most durable artifact. Using 10% of a pre-1.0 library on the render path to save 40 lines is not a trade worth making. The keyed-map adapter is still there, so this is reversible; `useUIStream`/`buildSpecFromParts` remain worth revisiting for progressive agent rendering in M2. (`createSpecStreamCompiler()`, named in an earlier draft of this plan, is not an export of 0.20.0.)

shadcn/Tailwind went for a related reason. shadcn's 36 components are not our 34 — different names, different props — so they would have been re-skinned wholesale, and the utility classes would have put presentation back into component files. Two stylesheets of hand-written CSS keyed on `data-` attributes do the job with no build step and one obvious place to change a colour, which is exactly the claim the architecture makes.

**Risk on `@modelcontextprotocol/ext-apps`:** real and published (v1.x, `registerAppTool` / `registerAppResource` from `@modelcontextprotocol/ext-apps/server`), but it has already shipped breaking changes across 0.x. Pin it; it only touches the third-party iframe path (M3).

**Vendor exposure, honestly:** MCP is open and multi-vendor, which is why it's the right bet — and the gateway hedges it structurally regardless. The model is commodity-swappable (tool-calling is table stakes); a switch costs prompt tuning and an eval re-run, not architecture. React is the largest lock-in and the safest. Recharts is now the only other UI dependency, and it touches one component.

---

## Repository layout

pnpm workspaces monorepo:

```
packages/
  protocol/          # PUP: Zod schemas, TS types, JSON Schema export — the contract
  catalog/           # 34 components (nested, flat-list/strict, keyed-map variants)
  identity/          # principal, tenant, audience, scopes, token exchange, audit schema
  mcp-gateway/       # MCP client pool, namespacing, RBAC/audience filter, redaction, shims
  agent/             # tool defs, render_screen, grounding validator, provenance
  public-api/        # brokered external façade — versioned separately from the catalog
  sdk-node/          # typed builders for satellite authors
  conformance/       # CLI: validates a satellite against PUP + audience rules
apps/
  hub/               # Next.js — shell, renderer, registry, proxy, agent, outward MCP
  satellite-orders/  # Node/Express — PUP + MCP — tables, forms, workflow
  satellite-fleet/   # Python/FastAPI — PUP only (proves the shim) — dashboard + charts
config/
  satellites.yaml
```

Two satellites in two languages: the polyglot claim is the political argument, so the demo proves it. One with MCP and one without proves the shim covers "most, not all."

---

## Build order

**M1 — Deterministic portal + identity spine (agent off)**
1. `packages/protocol` — `ScreenResponse`, `ActionResponse`, `Manifest`; Zod source of truth, JSON Schema exported.
2. `packages/catalog` — the 34 components; emit nested, flat-list/strict, keyed-map variants.
3. `packages/identity` — principal/tenant/audience model, token exchange, **audit schema**. *In M1 deliberately: audit retrofitted onto regulated data is a re-certification, not a patch.*
4. `apps/hub` shell — layout, nav from registry, theme tokens, route `/{satelliteId}/{screenId}`.
5. BFF proxy — registry lookup, audience filter, timeout, circuit breaker, validation, adapter.
6. Renderer bindings + action dispatch.
7. `satellite-orders` (Node) and `satellite-fleet` (Python), both enforcing their own tenant scoping.

**M2 — Agent + MCP gateway**
8. `packages/mcp-gateway` — namespacing, RBAC/audience filter, PUP→MCP shim, tool invocation and audit *(done)*; MCP client pool for satellites that ship a server *(next — no satellite ships one yet, and the shim is what makes that survivable)*.
9. `packages/agent` — the strict `render_screen` schema, lowering, grounding, the model loop, the tool surface and provenance rendering *(done)*.
10. Confirmation flow for `requiresConfirmation` tools; per-tenant kill switch *(done)*.
11. Agent-composed home screen.

**M3 — External surfaces**
12. `packages/public-api` — brokered façade over audience-external declarations, versioned independently *(done)*.
13. Outward MCP server — aggregated tools over one governed endpoint *(done)*; `ui://` resources and the MCP Apps path *(deferred with M3's third-party work)*.
14. MCP→PUP generation — a tools-only satellite gets generated screens.
15. Third-party MCP path — compliant sandboxed-iframe fallback with foreign-source chrome.
16. `packages/conformance` and `packages/sdk-node` — the adoption ergonomics that decide whether teams onboard *(done)*.

---

## Verification

`pnpm dev` (hub :3000, orders :4001, fleet :4002):

1. **Unified branding** — both satellites render identically; flip a hub token, both change. Neither shipped a byte of CSS.
2. **Deep linking** — detail screen, copy URL, reload, browser back. All work. (Where iframes and MFE routing break.)
3. **Round-trip workflow** — bad data → `fieldErrors` inline; fix → `toast` + `patch` re-renders one table.
4. **The money moment** — edit a satellite's JSON while the hub runs, refresh, new UI. No hub deploy, no hub code change.
5. **Blast radius** — kill fleet mid-demo. Scoped error card; nav and orders unaffected.
6. **Trust boundary** — satellite returns `{"type":"Script"}` or a `className`. Proxy rejects it.
7. **Tenant isolation** — call a satellite directly, bypassing the hub, with tenant A's token for tenant B's record. **Satellite refuses.** This is the test that proves authz isn't hub-dependent.
8. **Audience default-deny** — an unmarked screen is invisible to an external principal and absent from the public API.
9. **Cross-satellite composition** — "which orders are blocked by vehicles in maintenance?" No satellite can answer it; the hub can. *This is the justification for the hub beyond cosmetics.*
10. **Grounding** — force a `StatTile` with no `source`. Rejected. Then trace a real number to its tool call.
11. **Regulated-data audit** — from the audit log alone, answer "which records did the agent read, for whom, when."
12. **Governed write** — agent proposes an approval; hub-styled confirmation; approve; verify audit entry.
13. **Agent off, per tenant** — deterministic portal fully intact for that tenant. Proves additive, never load-bearing.
14. **Outward MCP** — point Claude Desktop at the hub; it works across both satellites through the gateway.
15. **Polyglot + shim** — fleet is Python, no MCP server, still agent-reachable via the generated shim.
16. **Conformance** — `pnpm conformance http://localhost:4001` passes; break a response, watch it fail precisely. It reports four states, and the distinction matters: a *skip* is never a pass. A screen behind a required parameter cannot be fetched without inventing a value, a screen refused for want of scopes is the probe's ignorance rather than the satellite's defect (required scopes live in the registry, which a satellite team may not have), and tenant isolation cannot be proved from outside with one tenant's credentials. All three come back as unchecked, with the reason, on every run — a green result that quietly omitted the important half is worse than a red one.

---

## Known limits to state up front

- **Expressiveness ceiling is real.** Tables/forms/dashboards, not maps, diagram editors, or canvases. Confirmed not needed. The escape hatch is a registered full-page iframe with hub nav and SSO — bounded, never the default.
- **We are forking MCP Apps on the first-party path.** A custom mime type is unsanctioned and native rendering contradicts a content-agnostic sandbox MUST. Accepted knowingly; cost is that portal-rendered satellite UI isn't portable to other MCP hosts, and a future spec-defined mime type may collide. Contained to the rendering path; satellites can serve an MCP-Apps HTML representation alongside.
- **The strict `render_screen` schema is 18.6 KB, not the problem this plan expected.** Measured rather than assumed: 34 variants, every object closed, one `oneOf` at the top level, and none of the length, range, pattern or format keywords structured outputs reject — the catalog's ban on those is most of the reason. What the exercise *did* surface was the open-object problem, which changed the grounding design (above) rather than the size budget. Which JSON Schema combinators strict tool schemas actually accept is still unverified from this repo; it is checked when the loop first calls the API, and the fallback remains prompt-plus-validate, keeping the grounding check in our own validator.
- **Schema validation is an integrity boundary, not a content-trust boundary.**
- **`extract` has outgrown the MCP gateway.** Three packages now depend on it — the gateway, the agent, and the public API — because turning a screen into data is what every non-rendering projection needs. It belongs in `@portal/catalog`, as the inverse of rendering. Left where it is for now and recorded here rather than moved in the same change that added the third consumer.
- **The public API authenticates like the rest of the prototype, which is to say barely.** It uses the same development session stub the screens do; production replaces it with partner credentials exchanged for a principal with `audience: "external"`. Nothing below changes when it does, because everything below already takes a `Principal` — but until then the façade is a demonstration of the projection, not of the authentication.
- **The agent conversation comes back from the browser unsigned, so the confirmation gate and grounding are protections against the *model*, not against the *user*.** The hub is stateless between turns by design, which means a client can post a hand-written assistant `tool_use` plus a matching approval and run a write with no confirmation card ever drawn, or forge `tool_result` blocks so grounding accepts an invented figure. RBAC is unaffected — the gateway still authorizes every call against the signed principal, and a user cannot reach anything they could not already reach by calling the action endpoint directly with their own credentials. What is actually damaged is attribution: the audit record would describe an agent turn the agent never took. The fix is an HMAC over the returned conversation, and it belongs with the per-tenant audit-digest key, which is the same open decision.
- **An action must declare its parameters or no agent can call it.** Screens have declared theirs since 1.0; actions had not, because the hub only ever posted whatever a form collected — enough while a human filled the form in. Protocol 1.1 adds optional typed `params` to an action descriptor, and the gateway skips any action that omits them. That is the honest failure: the alternative is a model guessing field names at a write endpoint.
- **Portal ids and MCP tool names are different grammars, and the projection between them is lossy.** Ids are dotted; tool names are `[a-zA-Z0-9_-]` and bounded at 64. `a.b` and `a_b` are distinct ids and one tool name — as are the *satellite* ids `a.b` and `a_b`, which collide across an entire namespace. Every colliding tool is dropped rather than one being kept arbitrarily, and collision detection runs before entitlement filtering so a name cannot resolve to different tools for different principals.
- **A read tool caps the rows it returns and says that it did.** Silently truncating is the worst option available: the model answers "3 orders" for a page of 3,000 and sounds certain.
- **An action does not learn which screen invoked it, so `patch` is only safe when every route to an action sits on the screen the patch addresses.** Found by building it: `orders.approve` is reachable only from the detail screen and was returning a patch for the list screen's table — a node the user was not looking at. The hub handles it (the patch is refused whole, the screen refetches, the reason goes to the console), but the satellite has to know the rule. The fix is a protocol addition — the invoking screen id travelling with the action — deferred rather than improvised mid-change.
- **A satellite re-opens a dismissed `Modal` by transitioning `open`, not by re-asserting it.** React keeps the component mounted across a patch, so `open: true` arriving at a modal the user already closed is indistinguishable from the render that opened it in the first place. Resetting on every patch instead would spuriously re-open a modal sitting outside the replaced subtree. Telling those apart needs per-node patch provenance.
- **File uploads have no representation in the action envelope.** `FileUpload` renders and says so on the control; the chosen file is deliberately left out of the payload, because sending the filename alone would read as an upload that worked. Needs a protocol addition, not a renderer workaround.
- **Charts need JavaScript; nothing else on a screen does.** Recharts measures its container before drawing, so the SVG appears after hydration rather than in the server's HTML. The container reserves its height, so there is no layout shift — but a chart is the one component that is blank with scripting off, and the only part of a screen that is not server-rendered.
- **Dates and money render in a fixed locale and in UTC.** Anything reading the ambient locale or timezone produces one string on the server and another in the browser, which React reports as a hydration mismatch — and never does so on a developer's machine running in UTC. Showing a viewer's own timezone is a real feature and a later one; it needs the zone to travel with the render rather than be read independently at each end.
- **Agent latency and cost** are an order of magnitude above the deterministic path. Deterministic by default; agent on explicit intent.
- **The vendor call is the one thing in the agent path not covered by a test.** Everything else — the tool surface, the confirmation gate, grounding, the loop — is exercised against a real satellite over a real socket with the model's turns scripted, because a test that depends on what a model chooses to say fails for reasons nobody can fix. That leaves exactly one file, `anthropic.ts`, verified only by running it. Which JSON Schema combinators strict tool schemas accept is confirmed the same way, on first contact.
- **The agent is off unless switched on, and that is the tested default.** No API key means no agent; `PORTAL_AGENT=off` means no agent; a tenant on `PORTAL_AGENT_DISABLED_TENANTS` means no agent for them. The compose stack sets no key, so every e2e run is a run of the portal with the agent disabled — which is how "mode 1 works with the agent switched off" stays true rather than aspirational.
- **Third-party MCP servers are a different trust tier** — sandboxed iframe, foreign chrome, no catalog access. Deliberately second-class.
- **The platform team is a real, ongoing cost.** This design trades per-solution UI work for a permanent platform function. If that team is defunded in year three, the catalog stops evolving and satellites start requesting the iframe escape hatch — which is how this degrades back into the portal it replaced. That risk is organizational, not technical, and no architecture removes it.

---

## References

- [MCP Apps specification (2026-01-26)](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) — `ui://`, `_meta.ui`, capability negotiation, sandbox requirements
- [MCP Apps announcement](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)
- [Shopify — Remote rendering: Shopify's take on extensible UI](https://shopify.engineering/remote-rendering-ui-extensibility)
- [Stripe Apps — styling constraints](https://docs.stripe.com/stripe-apps/style) (design tokens, proprietary layout system, no arbitrary fonts) and [UI components](https://docs.stripe.com/stripe-apps/components)
- [Vercel Labs — json-render](https://github.com/vercel-labs/json-render) — evaluated and not adopted; see the reversal note
- [Martin Fowler — Micro Frontends](https://martinfowler.com/articles/micro-frontends.html)
- [Open-source MCP gateways, 2026](https://www.lunar.dev/post/the-best-open-source-mcp-gateways-in-2026)
- RFC 8693 — OAuth 2.0 Token Exchange
