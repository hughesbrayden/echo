import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No Next.js button over the controls, so screen recordings stay clean.
  // Build and runtime errors still show.
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
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
