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
  ...(deploymentId ? { deploymentId } : {}),
  env: {
    NEXT_PUBLIC_OBSERVABILITY_RELEASE: release,
    ...(release ? { NEXT_PUBLIC_BUILD_TIMESTAMP: new Date().toISOString() } : {}),
  },
  transpilePackages: [
    "@opencompany/agent-runtime",
    "@opencompany/db",
    "@opencompany/goat-brain",
    "@opencompany/ui",
  ],
};

export default nextConfig;
