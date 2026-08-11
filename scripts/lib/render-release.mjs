export function selectNewDeployForRelease(deploys, releaseSha, existingDeployIds) {
  return (
    deploys.find(
      (deploy) =>
        !existingDeployIds.has(deploy?.id) &&
        deploy?.trigger === "api" &&
        deployCommitMatches(deploy, releaseSha),
    ) ?? null
  );
}

export function deployCommitMatches(deploy, expectedSha) {
  const commitId = deploy?.commit?.id;
  return (
    typeof commitId === "string" &&
    (expectedSha.startsWith(commitId) || commitId.startsWith(expectedSha))
  );
}

export function isFailedDeployStatus(status) {
  return (
    status === "build_failed" ||
    status === "update_failed" ||
    status === "canceled" ||
    status === "deactivated" ||
    status === "pre_deploy_failed"
  );
}
