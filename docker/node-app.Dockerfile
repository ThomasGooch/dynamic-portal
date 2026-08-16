# syntax=docker/dockerfile:1

# One image definition for every Node service in the workspace. The app is
# selected with --build-arg APP_PATH, so a new satellite gets a container by
# adding four lines to docker-compose.yml rather than a new Dockerfile.
#
# Built from the repository root, because a pnpm workspace resolves
# dependencies across package boundaries and cannot be built from a subdirectory.

ARG NODE_VERSION=24
ARG PNPM_VERSION=11.22.0

# ---- base: pinned toolchain -------------------------------------------------
FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
# pnpm is installed explicitly rather than through corepack: corepack ships with
# Node only up to v25, so depending on it would break the image on the next LTS.
RUN npm install -g pnpm@${PNPM_VERSION}
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

# ---- deps: cacheable dependency layer --------------------------------------
# Only manifests are copied here, so editing source does not invalidate the
# (slow) install layer.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/protocol/package.json  packages/protocol/package.json
COPY apps/satellite-orders/package.json apps/satellite-orders/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- runtime ----------------------------------------------------------------
FROM deps AS runtime
ARG APP_PATH
ENV APP_PATH=${APP_PATH}
COPY . .
# Drop privileges: the node image ships a non-root `node` user.
RUN chown -R node:node /repo
USER node
# APP_PATH is resolved at runtime so one image can serve any workspace app.
CMD ["sh", "-c", "pnpm --filter ./${APP_PATH} start"]
