import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export — the dashboard is a client-only SPA, served as assets by the
  // Cloudflare Worker (no SSR / OpenNext needed).
  output: "export",
  images: { unoptimized: true },
  // @stacks/connect (+ its siblings) trip a Turbopack chunking bug ("module
  // factory is not available") under static export; transpiling them through
  // Next's pipeline fixes it.
  transpilePackages: ["@stacks/connect", "@stacks/transactions", "@stacks/common", "@stacks/network"],
};

export default nextConfig;
