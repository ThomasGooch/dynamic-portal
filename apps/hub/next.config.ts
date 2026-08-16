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
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  turbopack: {
    // TypeScript's convention is that a relative import writes `.js` even when
    // the file on disk is `.ts` — correct, and what a future build-to-JS step
    // will need. The bundler has to be told, or it looks for a `.js` that has
    // never existed and reports the package as unresolvable.
    resolveExtensions: [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".json"],
  },
  webpack: (webpackConfig: {
    resolve: { extensionAlias?: Record<string, string[]> };
  }) => {
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return webpackConfig;
  },
};

export default config;
