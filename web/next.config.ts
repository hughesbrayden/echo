import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No Next.js button over the controls, so screen recordings stay clean.
  // Build and runtime errors still show.
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
  // The site is the Echo story and a Live demo page that plays a recorded walk,
  // both standalone pages in public/ (see scripts/port-story.py). The camera app
  // is switched off for now.
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", destination: "/story.html" },
        { source: "/demo", destination: "/demo.html" },
      ],
      afterFiles: [],
      fallback: [],
    };
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
