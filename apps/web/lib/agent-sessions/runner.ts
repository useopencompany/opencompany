import { captureException, createLogger } from "@opencompany/observability";

type RunnerContext = {
  workspace_id?: string;
  session_id?: string;
  message_id?: string;
  event?: string;
};

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

function runnerInternalBaseUrl() {
  const value = process.env.RUNNER_INTERNAL_URL ?? process.env.RUNNER_PUBLIC_URL;
  if (!value) {
    throw new Error("RUNNER_INTERNAL_URL or RUNNER_PUBLIC_URL is required to contact the runner.");
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

export async function callRunner(path: string, context: RunnerContext = {}) {
  try {
    const response = await fetch(`${runnerInternalBaseUrl()}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runnerToken()}`,
      },
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Runner request failed with ${response.status}: ${details}`);
    }
    logger.info("Runner request succeeded", {
      runner_path: path,
      runner_status: response.status,
      ...context,
      event: "opencompany.runner_request_succeeded",
    });
  } catch (error) {
    captureException(error, {
      runner_path: path,
      ...context,
      event: context.event ?? "opencompany.runner_request_failed",
    });
    logger.warn("Runner request failed", {
      event: context.event ?? "opencompany.runner_request_failed",
      runner_path: path,
      ...context,
      error,
    });
    throw error;
  }
}

export function getRunnerPublicUrl() {
  return process.env.RUNNER_PUBLIC_URL?.replace(/\/+$/, "") ?? null;
}

export function getRunnerStreamTokenSecret() {
  return process.env.RUNNER_STREAM_TOKEN_SECRET?.trim() || null;
}
