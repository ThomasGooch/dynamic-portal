# syntax=docker/dockerfile:1

# Image for .NET services in the workspace. Built from the repository root,
# because a satellite takes `Portal.Sdk` as a project reference and the SDK is
# generated from the hub's catalog rather than published to a feed — so the
# image has to keep the repository's shape rather than flattening the app.

ARG DOTNET_VERSION=9.0

FROM mcr.microsoft.com/dotnet/sdk:${DOTNET_VERSION} AS build
ARG APP_PATH
ARG PROJECT
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1
WORKDIR /src

# The SDK first: it changes when the catalog does, which is rarely, so this
# layer stays cached across satellite edits.
COPY packages/sdk-csharp/Portal.Sdk /src/packages/sdk-csharp/Portal.Sdk
COPY ${APP_PATH} /src/${APP_PATH}

# `--no-restore` is deliberately absent: there is no lockfile equivalent being
# honoured here, so restoring is the step that resolves the project reference.
RUN dotnet publish "/src/${APP_PATH}/src/${PROJECT}/${PROJECT}.csproj" \
      -c Release -o /app --nologo

FROM mcr.microsoft.com/dotnet/aspnet:${DOTNET_VERSION} AS runtime
ARG PROJECT
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    ASPNETCORE_FORWARDEDHEADERS_ENABLED=true
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app .

# A non-root user, matching the other two images.
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

# `PROJECT` is not available at runtime, so the entrypoint is baked in at build
# time rather than read from an ARG that would be empty.
ENV APP_DLL=${PROJECT}.dll
CMD ["sh", "-c", "exec dotnet \"$APP_DLL\""]
