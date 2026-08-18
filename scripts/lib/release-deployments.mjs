import { RELEASE_STATE_SURFACES } from "./release-scope.mjs";

export function deploymentEnvironment(surface) {
  assertSurface(surface);
  return `production-${surface}`;
}

export function latestSuccessfulDeploymentSha(deployments, statusesByDeploymentId) {
  for (const deployment of deployments) {
    const statuses = statusesByDeploymentId.get(deployment.id) ?? [];
    if (/^[a-f0-9]{40}$/iu.test(deployment.sha ?? "") && statuses[0]?.state === "success") {
      return deployment.sha;
    }
  }
  return "";
}

export async function githubRequest(path, { token, method = "GET", body } = {}) {
  if (!token) throw new Error("GITHUB_TOKEN is required.");
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? parseJson(text) : null;
  if (!response.ok) {
    throw new Error(
      `GitHub API ${method} ${path} failed: ${response.status} ${
        payload?.message ?? response.statusText
      }`,
    );
  }
  return payload;
}

export async function findLastSuccessfulSurfaceSha({ repository, surface, token }) {
  assertSurface(surface);
  const environment = encodeURIComponent(deploymentEnvironment(surface));
  const deployments = await githubRequest(
    `/repos/${repository}/deployments?environment=${environment}&per_page=100`,
    { token },
  );
  for (const deployment of deployments) {
    if (!/^[a-f0-9]{40}$/iu.test(deployment.sha ?? "")) continue;
    const statuses = await githubRequest(
      `/repos/${repository}/deployments/${deployment.id}/statuses?per_page=1`,
      { token },
    );
    if (statuses[0]?.state === "success") return deployment.sha;
  }
  return "";
}

export function assertSurface(surface) {
  if (!RELEASE_STATE_SURFACES.includes(surface)) {
    throw new Error(`Unknown production surface: ${surface}`);
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
