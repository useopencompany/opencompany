import { createMDX } from "fumadocs-mdx/next";

const release =
  process.env.RELEASE_SHA ||
  process.env.GITHUB_SHA ||
  process.env.NEXT_PUBLIC_OBSERVABILITY_RELEASE ||
  process.env.OBSERVABILITY_RELEASE ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
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
    // Stamped when this config is evaluated during `vercel build` in the release
    // workflow, which runs minutes before `vercel deploy --prebuilt` — close
    // enough to serve as the "last deployed" time without extra CI plumbing.
    // Only set for release builds (commit sha present) so local dev doesn't show
    // a misleading dev-server start time.
    ...(release ? { NEXT_PUBLIC_BUILD_TIMESTAMP: new Date().toISOString() } : {}),
  },
  transpilePackages: [
    "@opencompany/analytics",
    "@opencompany/db",
    "@opencompany/observability",
    "@opencompany/ui",
  ],
  // The workspace route group moved from the root to /company. Keep old root
  // links (bookmarks, emails, stale clients) working with temporary redirects.
  async redirects() {
    const workspaceRoutes = [
      "agents",
      "settings",
      "session",
      "inbox",
      "brain",
      "people",
      "org-chart",
      "companies",
    ];
    return workspaceRoutes.map((route) => ({
      source: `/${route}/:path*`,
      destination: `/company/${route}/:path*`,
      permanent: false,
    }));
  },
};

const withMDX = createMDX();

export default withMDX(nextConfig);
