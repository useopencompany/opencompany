type RunnerContext = {
  task_id: string;
  event?: string;
};

function runnerInternalBaseUrl() {
  return (process.env.RUNNER_INTERNAL_URL ?? process.env.RUNNER_PUBLIC_URL)?.replace(/\/+$/, "");
}

function runnerToken() {
  return process.env.RUNNER_INTERNAL_TOKEN?.trim();
}

export function goatRunnerConfigured() {
  return Boolean(runnerInternalBaseUrl() && runnerToken());
}

export async function triggerGoatTaskRun(
  taskId: string,
  context: RunnerContext = { task_id: taskId },
) {
  const baseUrl = runnerInternalBaseUrl();
  const token = runnerToken();
  if (!baseUrl || !token) {
    console.warn("Goat runner request skipped because the runner is not configured.", {
      event: "goat.runner_request_unconfigured",
      task_id: taskId,
    });
    return;
  }

  const response = await fetch(`${baseUrl}/internal/goat/tasks/${taskId}/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Goat runner request failed with ${response.status}: ${details}`);
  }

  console.info("Goat runner request accepted.", {
    event: context.event ?? "goat.runner_request_accepted",
    task_id: taskId,
  });
}
