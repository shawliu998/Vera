import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The Electron build consumes only Next's traced production runtime. This
  // prevents the desktop package from copying the development `.next` tree
  // or the workstation's entire `node_modules` directory.
  output: "standalone",
  // The desktop repository may live inside a macOS File Provider directory
  // (for example Documents/iCloud Drive). Multiple Next build workers can
  // race that provider while publishing the same manifest tree, producing
  // conflict-suffixed directories or a partially visible server manifest.
  // A single production writer is slower but deterministic, and packaging is
  // an offline release operation rather than a request-serving hot path.
  experimental: {
    cpus: 1,
    webpackBuildWorker: false,
    staticGenerationMaxConcurrency: 1,
  },
  /* config options here */
  distDir:
    process.env.NEXT_DIST_DIR ??
    (process.env.NODE_ENV === "production" ? ".next-build" : ".next"),
  reactCompiler: true,
  devIndicators: false,
  async rewrites() {
    return [
      {
        source: "/sitemap.xml",
        destination: "/api/sitemap/sitemap.xml",
      },
      {
        source: "/sitemap_:slug.xml",
        destination: "/api/sitemap/sitemap_:slug.xml",
      },
    ];
  },
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
