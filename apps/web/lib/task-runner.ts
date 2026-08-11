import type { GoatHarnessSpec } from "@opencompany/db/goat-schema";

const CODEX_CHAT_WAKE_TIMEOUT_MS = 5_000;
const CODEX_CHAT_SANDBOX_STATUS_TIMEOUT_MS = 5_000;
const CODING_WORKSPACE_RUNTIME_ACCESS_TIMEOUT_MS = 10_000;
const GOAT_DICTATION_ACCESS_TIMEOUT_MS = 10_000;

export type GoatCodexSandboxStatus = "running" | "sleeping" | "deleted";
export type GoatCodingWorkspaceRuntimeAccess = {
  websocketUrl: string;
  ticket: string;
  expiresAt: number;
  sandboxStatus: Exclude<GoatCodexSandboxStatus, "deleted">;
};
export type GoatDictationAccess = {
  websocketUrl: string;
  ticket: string;
  expiresAt: number;
};

function runnerInternalBaseUrl() {
  const internalUrl = process.env.RUNNER_INTERNAL_URL?.trim();
  const publicUrl = process.env.RUNNER_PUBLIC_URL?.trim();
  return (internalUrl || publicUrl)?.replace(/\/+$/, "");
}

function runnerToken() {
  return process.env.RUNNER_INTERNAL_TOKEN?.trim();
}

function runnerPublicBaseUrl() {
  const publicUrl = process.env.RUNNER_PUBLIC_URL?.trim().replace(/\/+$/, "");
  const goatUrl = process.env.GOAT_NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (!publicUrl || !goatUrl) return publicUrl;
  try {
    const runner = new URL(publicUrl);
    const goat = new URL(goatUrl);
    if (
      goat.protocol === "https:" &&
      runner.protocol === "http:" &&
      (runner.hostname === "localhost" || runner.hostname === "127.0.0.1")
    ) {
      return goatUrl;
    }
  } catch {
    return publicUrl;
  }
  return publicUrl;
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

export async function triggerGoatCodexChatWake() {
  const baseUrl = runnerInternalBaseUrl();
  const token = runnerToken();
  if (!baseUrl || !token) {
    console.warn("Goat codex chat wake skipped because the runner is not configured.", {
      event: "goat.codex_chat_wake_unconfigured",
    });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CODEX_CHAT_WAKE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/internal/goat/codex-chat/wake`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Goat codex chat wake failed with ${response.status}: ${details}`);
  }
}

export async function getGoatCodexSandboxStatus(
  sandboxId: string,
): Promise<GoatCodexSandboxStatus> {
  const baseUrl = runnerInternalBaseUrl();
  const token = runnerToken();
  if (!baseUrl || !token) {
    throw new Error("Goat runner is not configured.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CODEX_CHAT_SANDBOX_STATUS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(
      `${baseUrl}/internal/goat/codex-chat/sandboxes/${encodeURIComponent(sandboxId)}/status`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Goat codex sandbox status failed with ${response.status}: ${details}`);
  }

  const body = (await response.json()) as { status?: unknown };
  if (body.status !== "running" && body.status !== "sleeping" && body.status !== "deleted") {
    throw new Error("Goat codex sandbox status returned an invalid status.");
  }
  return body.status;
}

export async function requestGoatCodingWorkspaceRuntimeAccess(input: {
  codingSessionId: string;
  userWorkosId: string;
}): Promise<GoatCodingWorkspaceRuntimeAccess> {
  const internalBaseUrl = runnerInternalBaseUrl();
  const publicBaseUrl = runnerPublicBaseUrl();
  const token = runnerToken();
  if (!internalBaseUrl || !publicBaseUrl || !token) {
    throw new Error("Goat runner runtime access is not configured.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CODING_WORKSPACE_RUNTIME_ACCESS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(
      `${internalBaseUrl}/internal/goat/coding-workspaces/sessions/${encodeURIComponent(input.codingSessionId)}/runtime-access`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userWorkosId: input.userWorkosId }),
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const message = typeof body?.error === "string" ? body.error : "Runtime access is unavailable.";
    throw new GoatCodingWorkspaceRequestError(message, response.status);
  }

  const body = (await response.json()) as Record<string, unknown>;
  if (
    typeof body.ticket !== "string" ||
    typeof body.expiresAt !== "number" ||
    (body.sandboxStatus !== "running" && body.sandboxStatus !== "sleeping")
  ) {
    throw new Error("Goat runner returned invalid runtime access.");
  }
  const websocketUrl = new URL("/goat/runtime", `${publicBaseUrl}/`);
  websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";

  return {
    websocketUrl: websocketUrl.toString(),
    ticket: body.ticket,
    expiresAt: body.expiresAt,
    sandboxStatus: body.sandboxStatus,
  };
}

export async function requestGoatDictationAccess(input: {
  userWorkosId: string;
}): Promise<GoatDictationAccess> {
  const internalBaseUrl = runnerInternalBaseUrl();
  const publicBaseUrl = runnerPublicBaseUrl();
  const token = runnerToken();
  if (!internalBaseUrl || !publicBaseUrl || !token) {
    throw new Error("Goat runner dictation access is not configured.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOAT_DICTATION_ACCESS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${internalBaseUrl}/internal/goat/dictation/access`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userWorkosId: input.userWorkosId }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const message = typeof body?.error === "string" ? body.error : "Dictation is unavailable.";
    throw new Error(message);
  }

  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body.ticket !== "string" || typeof body.expiresAt !== "number") {
    throw new Error("Goat runner returned invalid dictation access.");
  }
  const websocketUrl = new URL("/goat/dictation", `${publicBaseUrl}/`);
  websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";

  return {
    websocketUrl: websocketUrl.toString(),
    ticket: body.ticket,
    expiresAt: body.expiresAt,
  };
}

export class GoatCodingWorkspaceRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "GoatCodingWorkspaceRequestError";
  }
}

export async function killGoatCodexSandbox(sandboxId: string): Promise<boolean> {
  const baseUrl = runnerInternalBaseUrl();
  const token = runnerToken();
  if (!baseUrl || !token) {
    throw new Error("Goat runner is not configured.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CODEX_CHAT_SANDBOX_STATUS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(
      `${baseUrl}/internal/goat/codex-chat/sandboxes/${encodeURIComponent(sandboxId)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Goat codex sandbox kill failed with ${response.status}: ${details}`);
  }

  const body = (await response.json()) as { killed?: unknown };
  return body.killed === true;
}

export async function triggerGoatBrainIngestWake() {
  const baseUrl = runnerInternalBaseUrl();
  const token = runnerToken();
  if (!baseUrl || !token) {
    console.warn("Goat Brain ingest wake skipped because the runner is not configured.", {
      event: "goat.brain_ingest_wake_unconfigured",
    });
    return;
  }

  const response = await fetch(`${baseUrl}/internal/goat/brain-ingest/wake`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Goat Brain ingest wake failed with ${response.status}: ${details}`);
  }
}

export async function triggerGoatGoogleDriveSyncWake() {
  const baseUrl = runnerInternalBaseUrl();
  const token = runnerToken();
  if (!baseUrl || !token) {
    console.warn("Goat Google Drive sync wake skipped because the runner is not configured.", {
      event: "goat.google_drive_sync_wake_unconfigured",
    });
    return;
  }

  const response = await fetch(`${baseUrl}/internal/goat/google-drive/sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Goat Google Drive sync wake failed with ${response.status}: ${details}`);
  }
}

export async function triggerGoatBrainImportWake() {
  const baseUrl = runnerInternalBaseUrl();
  const token = runnerToken();
  if (!baseUrl || !token) {
    console.warn("Goat Brain import wake skipped because the runner is not configured.", {
      event: "goat.brain_import_wake_unconfigured",
    });
    return;
  }
  const response = await fetch(`${baseUrl}/internal/goat/brain-import/wake`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Goat Brain import wake failed with ${response.status}: ${details}`);
  }
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
