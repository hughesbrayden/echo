import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No Next.js button over the controls, so screen recordings stay clean.
  // Build and runtime errors still show.
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
  // The landing page is the Echo story, a standalone page in public/ (see
  // scripts/port-story.py). The camera app lives at /demo.
  async rewrites() {
    return { beforeFiles: [{ source: "/", destination: "/story.html" }], afterFiles: [], fallback: [] };
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
