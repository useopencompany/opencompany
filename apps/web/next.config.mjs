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
  // Pin a custom deployment ID so Vercel Skew Protection works with our prebuilt
  // deploys (`vercel build` + `vercel deploy --prebuilt`). Next writes this into
  // the build output (routes-manifest.json) and stamps it on client requests, so a
  // stale client's Server Actions/assets route to the deployment that served its
  // page instead of throwing into the error boundary. Must be unique per release
  // and must not start with `dpl_`; the commit SHA satisfies both. Only set when
  // present so local `next dev`/`next build` are unaffected.
  ...(release ? { deploymentId: release } : {}),
  env: {
    NEXT_PUBLIC_OBSERVABILITY_RELEASE: release,
  },
  transpilePackages: ["@opencompany/analytics", "@opencompany/db", "@opencompany/observability"],
};

const withMDX = createMDX();

export default withMDX(nextConfig);
