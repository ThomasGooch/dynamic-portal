# syntax=docker/dockerfile:1

# Image for Python services in the workspace. Built from the repository root,
# and — since the Python SDK arrived — genuinely dependent on that: a satellite
# takes `portal-sdk` as an editable path dependency, so the image has to keep
# the repository's shape rather than flattening the app into /app. Flattening
# is what it used to do, and `../../packages/sdk-python` then resolved above the
# build context and failed the build.

ARG PYTHON_VERSION=3.13
ARG UV_VERSION=0.12.5

# A named stage rather than `COPY --from=ghcr.io/astral-sh/uv:${UV_VERSION}`:
# BuildKit does not expand variables in `--from`, but it does in `FROM`, so this
# is what keeps the uv version a single ARG instead of a literal that drifts.
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

FROM python:${PYTHON_VERSION}-slim AS base
ARG APP_PATH
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH=/app/.venv/bin:$PATH
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app

# ---- deps: cacheable layer keyed on the lockfile only --------------------
FROM base AS deps
ARG APP_PATH
# The SDK first: it is a path dependency, so `uv sync` needs it present, and
# copying it before the lockfile keeps this layer keyed on things that rarely
# change. It is generated from the hub's catalog rather than published.
COPY packages/sdk-python /app/packages/sdk-python
COPY ${APP_PATH}/pyproject.toml ${APP_PATH}/uv.lock /app/${APP_PATH}/
WORKDIR /app/${APP_PATH}
# --frozen fails rather than silently re-resolving, so the image cannot drift
# from the committed lockfile. --no-dev keeps pytest out of the runtime image.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# ---- runtime --------------------------------------------------------------
FROM deps AS runtime
ARG APP_PATH
COPY ${APP_PATH}/src /app/${APP_PATH}/src
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser
ENV PATH=/app/${APP_PATH}/.venv/bin:$PATH \
    PYTHONPATH=/app/${APP_PATH}/src
CMD ["python", "-m", "satellite_fleet.server"]
