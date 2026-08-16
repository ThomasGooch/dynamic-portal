import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const workspacePackages = [
  "@portal/protocol",
  "@portal/identity",
  "@portal/catalog",
  "@portal/registry",
];

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source rather than built JS, so Next
  // compiles them alongside the app instead of treating them as external.
  transpilePackages: workspacePackages,
  // `fileURLToPath`, not `.pathname`: a URL percent-encodes, so a checkout under
  // a path with a space would hand Next `/Users/me/My%20Projects/...`, which is
  // not a directory that exists.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
};

export default config;
