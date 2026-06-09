import { createMDX } from "fumadocs-mdx/next";

const release =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.RELEASE_SHA ||
  process.env.GITHUB_SHA ||
  process.env.NEXT_PUBLIC_OBSERVABILITY_RELEASE ||
  process.env.OBSERVABILITY_RELEASE ||
  "";
const vercelManagedDeploymentId = process.env.NEXT_DEPLOYMENT_ID?.startsWith("dpl_") ?? false;
const deploymentId = vercelManagedDeploymentId ? "" : release.slice(0, 32);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin a custom deployment ID so Vercel Skew Protection works with our prebuilt
  // deploys (`vercel build` + `vercel deploy --prebuilt`). Next writes this into
  // the build output (routes-manifest.json) and stamps it on client requests, so a
  // stale client's Server Actions/assets route to the deployment that served its
  // page instead of throwing into the error boundary. Must be unique per release
  // and must not start with `dpl_`. Vercel caps custom IDs at 32 characters, so
  // use the commit prefix for skew protection while preserving the full release
  // value for observability. Vercel-managed builds already inject NEXT_DEPLOYMENT_ID
  // with a platform `dpl_...` value; in that path, let Next use Vercel's deployment
  // identity instead of providing a conflicting custom ID. Only set when present so
  // local `next dev`/`next build` are unaffected.
  ...(deploymentId ? { deploymentId } : {}),
  env: {
    NEXT_PUBLIC_OBSERVABILITY_RELEASE: release,
  },
  transpilePackages: ["@opencompany/analytics", "@opencompany/db", "@opencompany/observability"],
};

const withMDX = createMDX();

export default withMDX(nextConfig);
