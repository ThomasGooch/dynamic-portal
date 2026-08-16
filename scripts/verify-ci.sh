#!/usr/bin/env bash
# Runs the CI workflow's steps, verbatim and in order, so "confident CI will be
# green" is a command with an exit code rather than a recollection.
#
# The distinction that matters: CI installs with --frozen-lockfile / --frozen,
# which FAIL on lockfile drift, while a plain `pnpm install` / `uv sync` quietly
# re-resolves and passes. That gap is the realistic way a PR goes red after a
# green local run, so this script always uses the CI form.
#
# Mirrors .github/workflows/ci.yml — if that changes, change this too.
set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf '\n\033[1m>> %s\033[0m\n' "$1"; }

step "node: install (--frozen-lockfile)"
pnpm install --frozen-lockfile

step "node: build (typecheck)"
pnpm typecheck

# The hub is noEmit and non-composite, so it cannot be a project reference and
# `tsc --build` above never visits it. Exactly the hole that let six compile
# errors sit in satellite-orders while CI stayed green.
step "hub: build (typecheck)"
pnpm --filter @portal/hub typecheck

# `tsc` cannot see server/client boundary violations, a bad next.config, or a
# page that fails to prerender — all of which bit during development.
step "hub: build (next build)"
PORTAL_PRINCIPAL_SECRET=verify-build-placeholder pnpm --filter @portal/hub build

step "node: test - unit"
pnpm test:unit

step "node: test - integration"
pnpm test:integration

step "python: install (--frozen)"
(cd apps/satellite-fleet && uv sync --frozen)

step "python: test - unit"
(cd apps/satellite-fleet && uv run pytest -m "not integration")

step "python: test - integration"
(cd apps/satellite-fleet && uv run pytest -m integration)

printf '\n\033[32mOK: CI-equivalent checks passed\033[0m\n'
