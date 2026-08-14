import { PROTOCOL_VERSION } from "@opencompany/protocol";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    ok: true,
    service: "opencompany-goat",
    mode: process.env.OPENCOMPANY_COMMUNITY_MODE === "1" ? "community" : "standard",
    capabilities:
      process.env.OPENCOMPANY_COMMUNITY_MODE === "1"
        ? {
            authentication: {
              status: "disabled",
              reason: "Configure a WorkOS project to enable sign-in.",
            },
          }
        : { authentication: { status: "configured" } },
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    protocolVersion: PROTOCOL_VERSION,
    release:
      process.env.RELEASE_SHA ??
      process.env.GITHUB_SHA ??
      process.env.NEXT_PUBLIC_OBSERVABILITY_RELEASE ??
      process.env.OBSERVABILITY_RELEASE ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      null,
    gitCommit: process.env.RELEASE_SHA ?? process.env.GITHUB_SHA ?? null,
    vercelGitCommitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  });
}
