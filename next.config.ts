import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server in .next/standalone (server.js + the subset of
  // node_modules it needs). The Dockerfile copies that folder, plus public/ and
  // .next/static, into a small runtime image for the Kubernetes deploy.
  output: "standalone",
  async rewrites() {
    return [
      // The ported <image-slot> component fetches this sidecar on load; serve
      // an empty store so there's no 404/400 in the console (drops aren't
      // persisted outside the design runtime — placeholders are intentional).
      { source: "/.image-slots.state.json", destination: "/api/image-slots" },
    ];
  },
};

export default nextConfig;
