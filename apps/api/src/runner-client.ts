// One client for the sanctioned API -> runner control direction. The two
// retired web callers parsed runner failures differently: the Codex device
// flow surfaced the raw status plus response text, while the Infisical flow
// surfaced the runner's JSON `error` message. errorFormat preserves both
// behaviors verbatim so the user-facing copy does not change across the
// cutover.

export type RunnerJsonErrorFormat = "status-text" | "error-message";

export type RunnerClient = {
  requestJson<TResponse>(
    path: string,
    options: {
      method: "GET" | "POST" | "DELETE";
      body?: Record<string, unknown>;
      errorFormat: RunnerJsonErrorFormat;
    },
  ): Promise<TResponse>;
  postJson<TResponse>(
    path: string,
    body: Record<string, unknown>,
    options: { errorFormat: RunnerJsonErrorFormat },
  ): Promise<TResponse>;
};

export function createRunnerClient(
  input: { url?: string; token?: string; fetch?: typeof globalThis.fetch } = {},
): RunnerClient {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const requestJson = async <TResponse>(
    path: string,
    options: {
      method: "GET" | "POST" | "DELETE";
      body?: Record<string, unknown>;
      errorFormat: RunnerJsonErrorFormat;
    },
  ): Promise<TResponse> => {
    const baseUrl = (
      input.url?.trim() ||
      process.env.RUNNER_INTERNAL_URL?.trim() ||
      process.env.RUNNER_PUBLIC_URL?.trim()
    )?.replace(/\/+$/, "");
    const token = input.token?.trim() || process.env.RUNNER_INTERNAL_TOKEN?.trim();
    if (!baseUrl || !token) throw new Error("Runner is not configured.");

    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!response.ok) {
      if (options.errorFormat === "status-text") {
        const details = await response.text();
        throw new Error(`Runner request failed with ${response.status}: ${details}`);
      }
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const reason = typeof payload?.error === "string" ? payload.error : "Runner request failed.";
      throw new Error(reason);
    }
    return (await response.json()) as TResponse;
  };
  return {
    requestJson,
    async postJson<TResponse>(
      path: string,
      body: Record<string, unknown>,
      options: { errorFormat: RunnerJsonErrorFormat },
    ): Promise<TResponse> {
      return requestJson(path, { method: "POST", body, errorFormat: options.errorFormat });
    },
  };
}
