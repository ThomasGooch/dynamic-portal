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

- Node >= 22
- pnpm (via `corepack pnpm`, pinned by the `packageManager` field)
- Python 3.11+ (for the `satellite-fleet` demo satellite)

## Getting started

```bash
corepack pnpm install
corepack pnpm test
```

## Conventions

- **TDD** — red, green, refactor. Tests land with (or before) the code they cover.
- **A branch per feature**, PR into `main`.
- **The catalog is additive-only.** Components are deprecated, never removed.
