import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ffmpeg-static resolves its binary relative to __dirname; bundling it
  // rewrites that path to a placeholder and the spawn fails with ENOENT.
  serverExternalPackages: ["ffmpeg-static"],
};

export default nextConfig;
