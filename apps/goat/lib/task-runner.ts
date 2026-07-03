import { GOAT_SPANS, recordGoatTaskDispatch, startGoatSpan } from "@opencompany/goat-observability";

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
  const startedAt = performance.now();
  const span = startGoatSpan(GOAT_SPANS.taskDispatch, {
    "goat.task_id": taskId,
    "goat.dispatch_mode": "runner_wake",
  });
  const baseUrl = runnerInternalBaseUrl();
  const token = runnerToken();
  if (!baseUrl || !token) {
    const attributes = {
      "goat.task_id": taskId,
      "goat.dispatch_mode": "runner_wake",
      "goat.outcome": "skipped",
      "goat.failure_category": "runner_unconfigured",
    };
    span.setAttributes(attributes);
    span.end();
    recordGoatTaskDispatch({
      durationMs: Math.round(performance.now() - startedAt),
      outcome: "skipped",
      attributes,
    });
    console.warn("Goat runner request skipped because the runner is not configured.", {
      event: "goat.runner_request_unconfigured",
      task_id: taskId,
    });
    return;
  }

  try {
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

    span.end({
      "goat.task_id": taskId,
      "goat.dispatch_mode": "runner_wake",
      "goat.outcome": "success",
    });
    recordGoatTaskDispatch({
      durationMs: Math.round(performance.now() - startedAt),
      outcome: "success",
      attributes: {
        "goat.task_id": taskId,
        "goat.dispatch_mode": "runner_wake",
      },
    });
  } catch (error) {
    const failureCategory = span.fail(error, {
      "goat.task_id": taskId,
      "goat.dispatch_mode": "runner_wake",
    });
    recordGoatTaskDispatch({
      durationMs: Math.round(performance.now() - startedAt),
      outcome: "failure",
      attributes: {
        "goat.task_id": taskId,
        "goat.dispatch_mode": "runner_wake",
        "goat.failure_category": failureCategory,
      },
    });
    throw error;
  }

  console.info("Goat runner request accepted.", {
    event: context.event ?? "goat.runner_request_accepted",
    task_id: taskId,
  });
}
