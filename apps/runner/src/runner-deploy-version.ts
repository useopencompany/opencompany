import { deployedRelease } from "@opencompany/observability";

export function runnerDeployVersion(env: NodeJS.ProcessEnv = process.env) {
  return deployedRelease(env) ?? "local";
}

export function recoveryReasonForDeployVersions(input: {
  current: string;
  previous: string | null;
}): "lease_reclaimed" | "cross_deploy" {
  return input.previous && input.previous !== input.current ? "cross_deploy" : "lease_reclaimed";
}
