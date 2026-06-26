export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    ok: true,
    service: "opencompany-connector",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
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
