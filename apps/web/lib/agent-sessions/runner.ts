function runnerBaseUrl() {
  const value = process.env.RUNNER_PUBLIC_URL;
  if (!value) {
    throw new Error("RUNNER_PUBLIC_URL is required to contact the runner.");
  }
  return value.replace(/\/+$/, "");
}

function runnerToken() {
  const value = process.env.RUNNER_INTERNAL_TOKEN;
  if (!value) {
    throw new Error("RUNNER_INTERNAL_TOKEN is required to contact the runner.");
  }
  return value;
}

export async function callRunner(path: string) {
  const response = await fetch(`${runnerBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runnerToken()}`,
    },
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Runner request failed with ${response.status}: ${details}`);
  }
}

export function getRunnerPublicUrl() {
  return process.env.RUNNER_PUBLIC_URL?.replace(/\/+$/, "") ?? null;
}
