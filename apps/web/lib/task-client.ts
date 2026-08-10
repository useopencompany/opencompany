import type { ContinueTaskResult } from "@/lib/tasks";

export async function continueGoatTask(
  taskId: string,
  prompt: string,
  clientMessageId: string,
  mentions?: unknown,
): Promise<ContinueTaskResult> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/continue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, clientMessageId, mentions }),
  });
  const body = await response.json().catch(() => null);
  if (isContinueTaskResult(body)) return body;

  return {
    ok: false,
    error: response.ok ? "Could not continue that task." : errorMessage(body),
    messageId: null,
  };
}

function isContinueTaskResult(value: unknown): value is ContinueTaskResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.ok === "boolean" &&
    (candidate.error === null || typeof candidate.error === "string") &&
    (candidate.messageId === null || typeof candidate.messageId === "string")
  );
}

function errorMessage(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const error = (value as Record<string, unknown>).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return "Could not continue that task.";
}
