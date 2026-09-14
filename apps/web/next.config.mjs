import { headlessApiRouting } from "./headless-api-routing.mjs";
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
const headlessApi = headlessApiRouting();

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
  async redirects() {
    return [
      {
        source: "/settings/integrations",
        destination: "/plugins",
        permanent: false,
      },
      // Plugins and Skills moved out of Settings into the main app view. Keep the old paths
      // working for bookmarks, Slack links, and OAuth apps configured with the former redirect.
      {
        source: "/settings/plugins",
        destination: "/plugins",
        permanent: false,
      },
      {
        source: "/settings/plugins/:path*",
        destination: "/plugins/:path*",
        permanent: false,
      },
      {
        source: "/settings/skills",
        destination: "/skills",
        permanent: false,
      },
      {
        source: "/settings/skills/:path*",
        destination: "/skills/:path*",
        permanent: false,
      },
      {
        source: "/settings/granola",
        destination: "/wiki/sources",
        permanent: false,
      },
      {
        source: "/settings/jamie",
        destination: "/plugins/jamie",
        permanent: false,
      },
      {
        source: "/settings/stripe",
        destination: "/plugins/stripe",
        permanent: false,
      },
      {
        source: "/docs/:path*",
        destination: "https://docs.opencompany.cloud/docs/:path*",
        permanent: false,
      },
    ];
  },
  ...(headlessApi.rewrites.length > 0
    ? {
        async headers() {
          return headlessApi.headers;
        },
        async rewrites() {
          return { beforeFiles: headlessApi.rewrites, afterFiles: [], fallback: [] };
        },
      }
    : {}),
  serverExternalPackages: ["@vercel/sandbox"],
  transpilePackages: [
    "@opencompany/agent-runtime",
    "@opencompany/analytics",
    "@opencompany/browser-tools",
    "@opencompany/db",
    "@opencompany/brain",
    "@opencompany/ui",
  ],
};

export default nextConfig;
