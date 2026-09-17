const DEFAULT_TIMEOUT_MS = 15_000;

export async function executeApiWorkflowCommand(input: {
  origin: string;
  token: string;
  workspaceId: string;
  actorId: string;
  toolInput: Record<string, unknown>;
  idempotencyKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const origin = input.origin.replace(/\/+$/u, "");
  if (!origin) throw new Error("The canonical API origin is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    const response = await fetch(`${origin}/internal/workflows/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.token}`,
        "idempotency-key": input.idempotencyKey,
      },
      body: JSON.stringify({
        userWorkosId: input.actorId,
        workspaceId: input.workspaceId,
        command: input.toolInput,
      }),
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const requestId = response.headers.get("x-request-id") ?? errorRequestId(payload);
      const message = errorMessage(payload) ?? `Workflow command failed (HTTP ${response.status}).`;
      throw new Error(requestId ? `${message} (request ${requestId})` : message);
    }
    const data = (payload as { data?: unknown } | null)?.data;
    if (!isWorkflowCommandOutput(data)) {
      throw new Error("The workflow command API returned an unexpected response.");
    }
    return data;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function isWorkflowCommandOutput(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}

// Reads the API's error envelope { error: { message, requestId } } without ever
// surfacing the raw response body or the bearer token.
function errorMessage(payload: unknown): string | null {
  const error = (payload as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === "string" && error.message.trim() ? error.message : null;
}

function errorRequestId(payload: unknown): string | null {
  const error = (payload as { error?: { requestId?: unknown } } | null)?.error;
  return typeof error?.requestId === "string" && error.requestId.trim() ? error.requestId : null;
}
