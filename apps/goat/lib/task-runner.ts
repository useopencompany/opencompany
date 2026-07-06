import type { GoatHarnessSpec } from "@opencompany/db/goat-schema";
import { GOAT_SPANS, recordGoatTaskDispatch, startGoatSpan } from "@opencompany/goat-observability";

type RunnerContext = {
  task_id: string;
  event?: string;
};

function runnerInternalBaseUrl() {
  const internalUrl = process.env.RUNNER_INTERNAL_URL?.trim();
  const publicUrl = process.env.RUNNER_PUBLIC_URL?.trim();
  return (internalUrl || publicUrl)?.replace(/\/+$/, "");
}

function runnerToken() {
  return process.env.RUNNER_INTERNAL_TOKEN?.trim();
}

export function goatRunnerConfigured() {
  return Boolean(runnerInternalBaseUrl() && runnerToken());
}

export async function planGoatTaskHarness(input: {
  userWorkosId: string;
  prompt: string;
}): Promise<GoatHarnessSpec> {
  const baseUrl = runnerInternalBaseUrl();
  const token = runnerToken();
  if (!baseUrl || !token) {
    throw new Error("Goat runner is not configured.");
  }

  const response = await fetch(`${baseUrl}/internal/goat/task-harness/plan`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Goat harness planning failed with ${response.status}: ${details}`);
  }

  const body = (await response.json()) as { harnessSpec?: unknown };
  if (!isGoatHarnessSpec(body.harnessSpec)) {
    throw new Error("Goat harness planning returned an invalid harness.");
  }
  return body.harnessSpec;
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

function isGoatHarnessSpec(value: unknown): value is GoatHarnessSpec {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === "goat.harness.v1" &&
    typeof record.model === "string" &&
    typeof record.systemPrompt === "string" &&
    typeof record.initialUserMessage === "string" &&
    Array.isArray(record.tools) &&
    typeof record.maxModelSteps === "number" &&
    (record.resultMode === "assistant_final" || record.resultMode === "brain_markdown_report")
  );
}
