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

step "sdk: regenerate from the catalog and check for drift"
# The Python SDK is generated from the catalog. Regenerating and diffing is what
# makes "it cannot drift" a fact rather than an intention: a component added to
# the catalog without regenerating fails here, not in a satellite six weeks on.
pnpm sdk:check

step "python: install (--frozen)"
(cd apps/satellite-fleet && uv sync --frozen)

step "python: test - unit"
(cd apps/satellite-fleet && uv run pytest -m "not integration")

step "python: test - integration"
(cd apps/satellite-fleet && uv run pytest -m integration)

step "python: test - sdk"
# Run from the satellite because that is where the environment with the SDK
# installed lives — and running it there also proves the path dependency works.
(cd apps/satellite-fleet && uv run pytest ../../packages/sdk-python/tests -q)

step "csharp: test"
# Through Docker unless a .NET SDK is on PATH. The repository is Docker-based,
# and this keeps a ~1GB toolchain off a laptop that would only need it here.
if command -v dotnet >/dev/null 2>&1; then
  (cd packages/sdk-csharp && dotnet test -v q --nologo)
elif command -v docker >/dev/null 2>&1; then
  docker run --rm -v "$PWD/packages/sdk-csharp:/src" -w /src \
    -e DOTNET_CLI_TELEMETRY_OPTOUT=1 -e DOTNET_NOLOGO=1 \
    mcr.microsoft.com/dotnet/sdk:9.0 dotnet test -v q --nologo
else
  printf '\n\033[31mNeither dotnet nor docker is available; the C# SDK cannot be tested.\033[0m\n'
  exit 1
fi

step "csharp: validate every envelope against the hub's schemas"
# The check a .NET test cannot perform: only the protocol package knows whether
# what the SDK built is a response the hub actually accepts.
pnpm sdk:csharp:validate

printf '\n\033[32mOK: CI-equivalent checks passed\033[0m\n'
