# Dynamic Portal

A central hub that renders every solution's UI from a declaration the solution owns — plus an LLM agent and an MCP gateway over the same vocabulary.

**No micro-frontends.** Satellites send *data, not code*. The hub owns all CSS, branding, shell, nav, and auth; satellites own what to display. Adding or changing a satellite screen requires **zero hub deployments**.

See **[PLAN.md](./PLAN.md)** for the full architecture, the durability thesis, and the build order.

## The idea in one picture

```
            ┌──────────────────────────────┐
            │   SATELLITE DECLARATIONS      │  ← the durable asset
            │   screens · actions · tools   │
            └──────────────┬───────────────┘
                           │
     ┌──────────┬──────────┼──────────┬──────────┐
     ▼          ▼          ▼          ▼          ▼
  Screens   Agent tools  Outward   Public API  (future
                          MCP      (brokered)  projections)
```

One declaration, many projections. "AI / MCP / API" are not three systems — they are three views of one asset.

## Status

Early. Building M1 (deterministic portal + identity spine). See the build order in `PLAN.md`.

## Requirements

- **Node >= 22** (developed on 24)
- **pnpm 11.22.0** — `brew install pnpm`, version pinned by the `packageManager` field.
  Not via corepack: corepack ships with Node only up to v25, so it stops being
  available on the next LTS.
- **Docker** with Compose v2+
- Python 3.11+ (for the `satellite-fleet` satellite, not yet built)

## Getting started

```bash
pnpm install
pnpm up          # build and start the stack in Docker
pnpm test:all    # unit → integration → e2e
pnpm down        # stop and remove volumes
```

Running services:

| Service | Language | Port | MCP server | Health |
|---|---|---|---|---|
| `hub` | TypeScript / Next.js | 3000 | **outward**, `POST /api/mcp` | `GET /` |
| `satellite-orders` | TypeScript | 4001 | **hosts one**, `POST /mcp` | `GET /healthz` |
| `satellite-fleet` | Python | 4002 | **none, deliberately** | `GET /healthz` |
| `satellite-depots` | C# / .NET | 4003 | **none, deliberately** | `GET /healthz` |

Open <http://localhost:3000>. The landing page is built from
`config/satellites.yaml` for the current principal, so a satellite you cannot
reach is absent from the response rather than hidden in the browser. There is no
sidebar — the cards below *are* the navigation, grouped and ordered by the
`nav: { section, order }` each satellite declares. The wordmark is the way back
to them from any screen.

The landing page is a card per solution: its health, and the figures it chose to
be summarised by. Neither half is hardcoded. Health comes from the `healthPath`
in each manifest, plus the hub's own circuit breaker — which is the one thing a
satellite cannot report about itself, since "the process is alive" and "the
hub's requests to it are working" are different questions. The figures are the
stat tiles on a screen the satellite nominates with `summary`, read with the
same extractor the agent's read tools use. So the front page can show no number
a team is not already showing its own users, nothing is declared twice, and
adding a fourth solution needs no hub change. Each card resolves in its own
`<Suspense>` boundary, so one slow satellite delays one card.

Three languages is not decoration. The protocol is a wire format, not a shared
library, and `satellite-fleet` shares no code with `@portal/protocol` — the e2e
tier parses its responses with the TypeScript schemas, which is where that stops
being a claim.

The MCP column is the other deliberate split. Two of three satellites ship no
MCP server, which is what keeps the hub's PUP-to-MCP shim exercised: a satellite
is agent-reachable for free, from the manifest it already publishes, with no
second server to run.

`satellite-orders` hosts one anyway, and the bar for that is not "MCP is good".
It is a capability PUP cannot express — `orders.search` takes a nested query,
and `orders.reconcile` has no screen at all. What the hub gained for it is zero
lines of satellite-specific code: `packages/mcp-gateway/src/client.ts` is
generic, and governance still comes from `config/satellites.yaml`. See
`apps/satellite-orders/src/mcp.ts` for the argument in full.

## Testing

Three tiers, separated by what they are allowed to touch. Tests live beside the
code they cover; the tier is chosen by filename, not directory.

| Tier | Command | Pattern | Touches |
|---|---|---|---|
| **unit** | `pnpm test` | `src/**/*.test.ts` | Pure logic. No sockets, no clock. |
| **integration** | `pnpm test:integration` | `src/**/*.integration.test.ts` | A real server on a real port, in-process. No browser. |
| **python** | `pnpm test:py` | `apps/satellite-fleet/tests/` | Both tiers for the Python satellite (`-m integration` splits them). |
| **e2e** | `pnpm test:e2e` | `e2e/**/*.spec.ts` | The running stack, over published ports. Requires `pnpm up`. |

`pnpm test:all` runs every tier in order.

The tiers earn their keep by failing differently. Integration tests verify the
code; e2e verifies the code *as deployed* — image, entrypoint, environment,
healthcheck, port mapping. A green integration suite alongside a broken
Dockerfile is exactly the gap the e2e tier closes.

`pnpm stack:test` runs the suite inside the same image the services run in, so a
green local run and a green containerised run mean the same thing.

**Before opening a PR, run `pnpm verify:ci`.** It executes the CI workflow's
steps verbatim and in order. The distinction matters: CI installs with
`--frozen-lockfile` / `--frozen`, which *fail* on lockfile drift, while a plain
`pnpm install` / `uv sync` quietly re-resolves and passes — which is the
realistic way a PR goes red after a green local run.

## Contributing

`main` is protected by a repository ruleset. Direct pushes, force-pushes and
deletion are refused; every change lands through a pull request with a green
**`build + test`** check.

**Review is a working agreement, not a ruleset rule.** Every PR gets a code
review pass with findings applied *before* it is merged — including PRs opened
by whoever wrote the code.

That split is deliberate. GitHub can require an *approval*, but it forbids a PR
author from approving their own pull request, and this repository has a single
collaborator who authors every PR. Requiring one approval therefore made every
PR permanently unmergeable, with no bypass — the requirement is only meaningful
once a second account with write access exists. Rather than weaken CI to work
around it (bypass actors skip *every* rule in a ruleset, including the status
check), the approval requirement is left off and the review is enforced by
process. Add it back when there is someone to do the approving.

## Configuration

`config/satellites.yaml` supports `${VAR}` and `${VAR:-default}`, the same
subset docker-compose uses. Hostnames are parameterised so one reviewed file
serves every environment — the default is a laptop, and compose overrides it
with service names. An unset variable with no default is a startup error rather
than a silent empty value.

| Variable | Purpose |
|---|---|
| `PORTAL_PRINCIPAL_SECRET` | Shared HMAC secret for principal tokens. Required; the hub and satellites refuse to start without it. |
| `PORTAL_AUDIT_KEY` | Root secret every tenant's audit digest key is derived from. Required by the hub; there is no unkeyed mode. |
| `PORTAL_AUDIT_LOG` | Absolute path the audit records are appended to. Required by the hub; writes fail closed, so its storage is on the critical path. |
| `PORTAL_REGISTRY_PATH` | Where to read the registry. Defaults to `config/satellites.yaml`. |
| `PORTAL_ORDERS_URL` / `PORTAL_FLEET_URL` / `PORTAL_DEPOTS_URL` | Satellite base URLs. |
| `PORTAL_DEV_TENANT` / `PORTAL_DEV_AUDIENCE` | Switch the development session's tenant or audience, for exercising isolation by hand. |
| `PORTAL_ALLOW_DEV_SESSION` | Lets the development session stub run under `NODE_ENV=production`. Set only by the compose stack. |
| `PORTAL_BRAND` | Which palette the portal wears. Every brand ships in the hub's stylesheet, so a rebrand costs no rebuild and no satellite is redeployed or told; applying it re-creates the hub container (`docker compose up -d hub`, not `restart`, which keeps the environment it was created with). Currently `contoso` and `partner`; unset is the default palette, and an unrecognised name is a startup error rather than a rebrand that silently did not happen. |

The session is a **development stub** and refuses to run under
`NODE_ENV=production` without that last flag. Production replaces it with OIDC
and RFC 8693 token exchange; nothing downstream changes, because everything
already takes a `Principal` and every satellite verifies the signature itself.

## Conventions

- **TDD** — red, green, refactor. Tests land with (or before) the code they cover.
- **A branch per feature**, PR into `main`. No merge without a review and green CI.
- **The catalog is additive-only.** Components are deprecated, never removed.
- **Satellites authorize themselves.** The hub authenticates and propagates the
  principal; every satellite independently enforces tenant scoping. A hub bug
  must be an availability incident, never a cross-tenant disclosure.
