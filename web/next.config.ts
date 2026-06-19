import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export — the dashboard is a client-only SPA, served as assets by the
  // Cloudflare Worker (no SSR / OpenNext needed).
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
