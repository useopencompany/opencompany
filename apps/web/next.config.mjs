import { createMDX } from "fumadocs-mdx/next";

const release =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.RELEASE_SHA ||
  process.env.GITHUB_SHA ||
  process.env.NEXT_PUBLIC_OBSERVABILITY_RELEASE ||
  process.env.OBSERVABILITY_RELEASE ||
  "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_OBSERVABILITY_RELEASE: release,
  },
  transpilePackages: ["@opencompany/analytics", "@opencompany/db", "@opencompany/observability"],
};

const withMDX = createMDX();

export default withMDX(nextConfig);
