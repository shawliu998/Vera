import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Electron build consumes only Next's traced production runtime. This
  // prevents the desktop package from copying the development `.next` tree
  // or the workstation's entire `node_modules` directory.
  output: "standalone",
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
