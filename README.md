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

| Service | Port | Health |
|---|---|---|
| `satellite-orders` | 4001 | `GET /healthz` |

## Testing

Three tiers, separated by what they are allowed to touch. Tests live beside the
code they cover; the tier is chosen by filename, not directory.

| Tier | Command | Pattern | Touches |
|---|---|---|---|
| **unit** | `pnpm test` | `src/**/*.test.ts` | Pure logic. No sockets, no clock. |
| **integration** | `pnpm test:integration` | `src/**/*.integration.test.ts` | A real server on a real port, in-process. No browser. |
| **e2e** | `pnpm test:e2e` | `e2e/**/*.spec.ts` | The running stack, over published ports. Requires `pnpm up`. |

The tiers earn their keep by failing differently. Integration tests verify the
code; e2e verifies the code *as deployed* — image, entrypoint, environment,
healthcheck, port mapping. A green integration suite alongside a broken
Dockerfile is exactly the gap the e2e tier closes.

`pnpm stack:test` runs the suite inside the same image the services run in, so a
green local run and a green containerised run mean the same thing.

## Contributing

`main` is protected by a repository ruleset. Direct pushes, force-pushes and
deletion are refused; every change lands through a pull request that has:

1. **One approving review**, and
2. **A green `build + test` check** (strict — the branch must be up to date with
   `main` before merging).

In addition, every PR gets a code review pass with findings applied *before*
merge — including PRs opened by whoever wrote the code. That part is a working
agreement rather than something the ruleset can express.

## Conventions

- **TDD** — red, green, refactor. Tests land with (or before) the code they cover.
- **A branch per feature**, PR into `main`. No merge without a review and green CI.
- **The catalog is additive-only.** Components are deprecated, never removed.
- **Satellites authorize themselves.** The hub authenticates and propagates the
  principal; every satellite independently enforces tenant scoping. A hub bug
  must be an availability incident, never a cross-tenant disclosure.
