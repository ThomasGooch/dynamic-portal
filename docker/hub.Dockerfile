# syntax=docker/dockerfile:1

# The hub. Separate from docker/node-app.Dockerfile because Next needs a build
# step and the satellites do not — folding both into one file would mean a build
# stage every satellite pays for and none of them uses.

ARG NODE_VERSION=24
ARG PNPM_VERSION=11.22.0

FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@${PNPM_VERSION}
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

# ---- deps -----------------------------------------------------------------
# Every workspace manifest, not just the hub's: a missing one does not error,
# it produces a dangling symlink and an unresolvable import much later.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/protocol/package.json  packages/protocol/package.json
COPY packages/identity/package.json  packages/identity/package.json
COPY packages/catalog/package.json   packages/catalog/package.json
COPY packages/registry/package.json  packages/registry/package.json
COPY packages/mcp-gateway/package.json packages/mcp-gateway/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY apps/satellite-orders/package.json apps/satellite-orders/package.json
COPY apps/hub/package.json apps/hub/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build ----------------------------------------------------------------
FROM deps AS build
COPY . .
# A placeholder secret: `next build` imports the modules that demand one, but
# nothing signs a token during a build. The real value arrives at runtime.
RUN PORTAL_PRINCIPAL_SECRET=build-time-placeholder pnpm --filter ./apps/hub build

# ---- runtime --------------------------------------------------------------
FROM build AS runtime
RUN chown -R node:node /repo
USER node
ENV NODE_ENV=production \
    PORTAL_REGISTRY_PATH=/repo/config/satellites.yaml
CMD ["pnpm", "--filter", "./apps/hub", "start"]
