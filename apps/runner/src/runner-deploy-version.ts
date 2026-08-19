export function runnerDeployVersion(env: NodeJS.ProcessEnv = process.env) {
  return (
    env.RENDER_GIT_COMMIT?.trim() ||
    env.OBSERVABILITY_RELEASE?.trim() ||
    env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    "local"
  );
}

export function recoveryReasonForDeployVersions(input: {
  current: string;
  previous: string | null;
}): "lease_reclaimed" | "cross_deploy" {
  return input.previous && input.previous !== input.current ? "cross_deploy" : "lease_reclaimed";
}
