import { createMDX } from "fumadocs-mdx/next";
import { SENSITIVE_CALLBACK_REQUEST_PATTERN } from "./request-logging.mjs";

const release =
  process.env.RELEASE_SHA ||
  process.env.GITHUB_SHA ||
  process.env.NEXT_PUBLIC_OBSERVABILITY_RELEASE ||
  process.env.OBSERVABILITY_RELEASE ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  "";
const vercelManagedDeploymentId = process.env.NEXT_DEPLOYMENT_ID?.startsWith("dpl_") ?? false;
const releaseWorkflowDeploymentId =
  release && process.env.GITHUB_RUN_ID
    ? `${release.slice(0, 10)}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || "1"}`
    : "";
const deploymentId = vercelManagedDeploymentId
  ? ""
  : `goat-${releaseWorkflowDeploymentId || release}`.slice(0, 32);

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(deploymentId ? { deploymentId } : {}),
  env: {
    NEXT_PUBLIC_OBSERVABILITY_RELEASE: release,
    ...(release ? { NEXT_PUBLIC_BUILD_TIMESTAMP: new Date().toISOString() } : {}),
  },
  logging: {
    incomingRequests: {
      ignore: [SENSITIVE_CALLBACK_REQUEST_PATTERN],
    },
  },
  transpilePackages: [
    "@opencompany/agent-runtime",
    "@opencompany/db",
    "@opencompany/goat-brain",
    "@opencompany/ui",
  ],
};

const withMDX = createMDX();

export default withMDX(nextConfig);
