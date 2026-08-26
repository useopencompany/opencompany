import { Sandbox, type SandboxNetworkOpts } from "e2b";
import { ACTIVE_CODING_SANDBOX_TIMEOUT_MS } from "./coding-sandbox-lifecycle";

export type SandboxHandle = Awaited<ReturnType<typeof Sandbox.create>>;
export type SandboxTextFile = {
  path: string;
  content: string | Uint8Array;
};
export type SandboxLatencyObservation = {
  operation: "create" | "connect";
  outcome: "success" | "not_found" | "error";
  latencyMs: number;
  sandboxId?: string;
  requestedSandboxId?: string;
  errorName?: string;
};

export const OPENCOMPANY_MANAGED_SANDBOX_METADATA_KEY = "opencompany_managed";
export const OPENCOMPANY_SANDBOX_OWNER_KIND_METADATA_KEY = "opencompany_owner_kind";
export const OPENCOMPANY_SANDBOX_OWNER_ID_METADATA_KEY = "opencompany_owner_id";

export type ManagedSandboxOwnerKind =
  | "codex_chat_session"
  | "codex_device_auth_flow"
  | "infisical_auth_flow";

export function managedSandboxMetadata(input: {
  ownerKind: ManagedSandboxOwnerKind;
  ownerId: string;
  metadata?: Record<string, string>;
}) {
  return {
    ...input.metadata,
    [OPENCOMPANY_MANAGED_SANDBOX_METADATA_KEY]: "true",
    [OPENCOMPANY_SANDBOX_OWNER_KIND_METADATA_KEY]: input.ownerKind,
    [OPENCOMPANY_SANDBOX_OWNER_ID_METADATA_KEY]: input.ownerId,
  };
}

// This timeout is armed once at create/connect and E2B pauses the sandbox when it elapses. It
// includes grace beyond the agent turn cap for bootstrap and finalization work outside that timer.
const ACTIVE_SANDBOX_TIMEOUT_MS = ACTIVE_CODING_SANDBOX_TIMEOUT_MS;
const SANDBOX_REQUEST_TIMEOUT_MS = 30_000;
// Resuming a paused sandbox can take longer than an ordinary control-plane request. Keep the
// larger deadline scoped to connect so transient E2B cold starts do not make a durable session
// unusable while routine sandbox operations still fail promptly.
const SANDBOX_CONNECT_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
export async function createOrConnectSandbox(input: {
  sandboxId?: string | null;
  template?: string | undefined;
  envs: Record<string, string>;
  metadata?: Record<string, string> | undefined;
  network?: SandboxNetworkOpts | undefined;
  idleTimeoutMs: number;
  onLatency?: (observation: SandboxLatencyObservation) => void | Promise<void>;
}) {
  if (input.sandboxId) {
    const sandbox = await connectSandbox({
      sandboxId: input.sandboxId,
      ...(input.onLatency ? { onLatency: input.onLatency } : {}),
    });
    if (sandbox) return sandbox;
  }

  return createSandbox(input);
}

export async function connectSandbox(input: {
  sandboxId: string;
  onLatency?: (observation: SandboxLatencyObservation) => void | Promise<void>;
}) {
  const startedAt = performance.now();
  try {
    const sandbox = await Sandbox.connect(input.sandboxId, {
      timeoutMs: ACTIVE_SANDBOX_TIMEOUT_MS,
      requestTimeoutMs: SANDBOX_CONNECT_REQUEST_TIMEOUT_MS,
    });
    emitSandboxLatency(input.onLatency, {
      operation: "connect",
      outcome: "success",
      latencyMs: elapsedMs(startedAt),
      sandboxId: sandbox.sandboxId,
      requestedSandboxId: input.sandboxId,
    });
    return sandbox;
  } catch (error) {
    const name = errorName(error);
    if (!isSandboxNotFound(error)) {
      emitSandboxLatency(input.onLatency, {
        operation: "connect",
        outcome: "error",
        latencyMs: elapsedMs(startedAt),
        requestedSandboxId: input.sandboxId,
        ...(name ? { errorName: name } : {}),
      });
      throw error;
    }
    emitSandboxLatency(input.onLatency, {
      operation: "connect",
      outcome: "not_found",
      latencyMs: elapsedMs(startedAt),
      requestedSandboxId: input.sandboxId,
      ...(name ? { errorName: name } : {}),
    });
    return null;
  }
}

async function createSandbox(input: {
  template?: string | undefined;
  envs: Record<string, string>;
  metadata?: Record<string, string> | undefined;
  network?: SandboxNetworkOpts | undefined;
  idleTimeoutMs: number;
  onLatency?: (observation: SandboxLatencyObservation) => void | Promise<void>;
}) {
  const options = {
    envs: input.envs,
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.network ? { network: input.network } : {}),
    timeoutMs: input.idleTimeoutMs,
    lifecycle: {
      onTimeout: "pause" as const,
      autoResume: true,
    },
  };

  const startedAt = performance.now();
  let sandbox: SandboxHandle;
  try {
    sandbox = input.template
      ? await Sandbox.create(input.template, options)
      : await Sandbox.create(options);
    emitSandboxLatency(input.onLatency, {
      operation: "create",
      outcome: "success",
      latencyMs: elapsedMs(startedAt),
      sandboxId: sandbox.sandboxId,
    });
  } catch (error) {
    const name = errorName(error);
    emitSandboxLatency(input.onLatency, {
      operation: "create",
      outcome: "error",
      latencyMs: elapsedMs(startedAt),
      ...(name ? { errorName: name } : {}),
    });
    throw error;
  }
  await sandbox.setTimeout(ACTIVE_SANDBOX_TIMEOUT_MS, {
    requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS,
  });
  return sandbox;
}

export type SandboxLifecycleStatus = "running" | "sleeping" | "deleted";

export async function getSandboxLifecycleStatus(
  sandboxId: string,
): Promise<SandboxLifecycleStatus> {
  try {
    const info = await Sandbox.getInfo(sandboxId, {
      requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS,
    });
    return info.state === "paused" ? "sleeping" : "running";
  } catch (error) {
    if (isSandboxNotFound(error)) return "deleted";
    throw error;
  }
}

function emitSandboxLatency(
  onLatency: ((observation: SandboxLatencyObservation) => void | Promise<void>) | undefined,
  observation: SandboxLatencyObservation,
) {
  try {
    void Promise.resolve(onLatency?.(observation)).catch(() => {});
  } catch {
    // Analytics must not affect sandbox provisioning.
  }
}

function elapsedMs(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export async function armSandboxIdleTimeout(sandbox: SandboxHandle, idleTimeoutMs: number) {
  try {
    const info = await sandbox.getInfo({ requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS });
    if (info.lifecycle?.onTimeout !== "pause") {
      await sandbox.pause({ requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS });
      return true;
    }

    await sandbox.setTimeout(idleTimeoutMs, { requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS });
    return true;
  } catch (error) {
    if (isSandboxNotFound(error)) {
      return false;
    }
    throw error;
  }
}

export async function keepSandboxActive(sandbox: SandboxHandle) {
  await sandbox.setTimeout(ACTIVE_SANDBOX_TIMEOUT_MS, {
    requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS,
  });
}

// Static E2B lifecycle calls do not resume a paused sandbox. This is used by terminal-state
// reconciliation after a runner hard-kill, where connecting just to shorten the timeout would
// unnecessarily wake an already-paused workspace.
export async function armSandboxIdleTimeoutById(sandboxId: string, idleTimeoutMs: number) {
  try {
    const info = await Sandbox.getInfo(sandboxId, {
      requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS,
    });
    if (info.state === "paused") return true;
    if (info.lifecycle?.onTimeout !== "pause") {
      await Sandbox.pause(sandboxId, { requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS });
      return true;
    }
    await Sandbox.setTimeout(sandboxId, idleTimeoutMs, {
      requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    if (isSandboxNotFound(error)) return false;
    throw error;
  }
}

export async function armSandboxActiveTimeoutById(sandboxId: string) {
  try {
    await Sandbox.setTimeout(sandboxId, ACTIVE_SANDBOX_TIMEOUT_MS, {
      requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    if (isSandboxNotFound(error)) return false;
    throw error;
  }
}

export async function killSandbox(sandboxId: string) {
  try {
    return await Sandbox.kill(sandboxId, { requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS });
  } catch (error) {
    if (isSandboxNotFound(error)) {
      return false;
    }
    throw error;
  }
}

export async function writeSandboxTextFiles(input: {
  sandbox: SandboxHandle;
  files: SandboxTextFile[];
  user?: string | undefined;
}) {
  if (input.files.length === 0) return;

  const files = input.files.map((file) => ({
    path: file.path,
    data: sandboxFileContent(file.content),
  }));
  if (input.user) {
    await input.sandbox.files.write(files, { user: input.user });
    return;
  }
  await input.sandbox.files.write(files);
}

function sandboxFileContent(content: SandboxTextFile["content"]) {
  if (typeof content === "string") return content;
  const copy = new Uint8Array(content.byteLength);
  copy.set(content);
  return copy.buffer;
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : undefined;
}

type CommandStreamCallback = (data: string) => void | Promise<void>;

/**
 * E2B's `CommandHandle.handleEvents` invokes `onStdout`/`onStderr` WITHOUT awaiting them,
 * so an async callback that rejects — e.g. the run-control gate throwing `RunAbortError`
 * when the user hits Stop mid-stream — becomes an unhandled promise rejection detached
 * from the awaited `commands.run` chain, which exits the whole multi-session Bun process
 * (prod crash 2026-06-10). This wraps the stream callbacks so they can never reject: the
 * first error is captured (later chunks are dropped) and surfaced via `rethrow()` at the
 * awaited boundary, where the regular tool-failure/abort handling can see it.
 */
export function guardCommandStreamCallbacks<
  T extends { onStdout?: CommandStreamCallback; onStderr?: CommandStreamCallback },
>(options: T): { options: T; rethrow: () => Promise<void> } {
  let failed = false;
  let callbackError: unknown;
  // Chain of in-flight callback invocations. `rethrow` waits for it so a rejection from
  // the final chunk — which e2b fires without awaiting, possibly in the same tick the
  // command result resolves — is still observed at the boundary. Links never reject
  // (errors are captured below), so the chain itself is safe to await.
  let settled: Promise<void> = Promise.resolve();

  const guard = (callback: CommandStreamCallback | undefined) =>
    callback &&
    ((data: string): Promise<void> => {
      const invocation = settled.then(async () => {
        if (failed) return;
        try {
          await callback(data);
        } catch (error) {
          failed = true;
          callbackError = error;
        }
      });
      settled = invocation;
      return invocation;
    });

  return {
    options: {
      ...options,
      onStdout: guard(options.onStdout),
      onStderr: guard(options.onStderr),
    } as T,
    rethrow: async () => {
      await settled;
      if (failed) throw callbackError;
    },
  };
}

export function commandExitResult(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (record.name !== "CommandExitError") return null;
  const result = readRecordProperty(record, "result");
  const candidates = result ? [result, record] : [record];
  const exitCode =
    candidates.map((candidate) => readNumberProperty(candidate, "exitCode")).find(isNumber) ??
    candidates.map((candidate) => readNumberProperty(candidate, "exit_code")).find(isNumber);
  if (exitCode == null) return null;

  return {
    stdout:
      candidates.map((candidate) => readStringProperty(candidate, "stdout")).find(isString) ?? "",
    stderr:
      candidates.map((candidate) => readStringProperty(candidate, "stderr")).find(isString) ?? "",
    exitCode,
  };
}

function readRecordProperty(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  try {
    const value = record[key];
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readNumberProperty(record: Record<string, unknown>, key: string): number | null {
  try {
    const value = record[key];
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

function readStringProperty(record: Record<string, unknown>, key: string): string | null {
  try {
    const value = record[key];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function isNumber(value: number | null): value is number {
  return typeof value === "number";
}

function isString(value: string | null): value is string {
  return typeof value === "string";
}

// E2B raises a `TimeoutError` when a command exceeds its `timeoutMs` (the process is killed
// server-side). Matched by name to stay decoupled from the SDK's class identity, mirroring
// `commandExitResult`. Lets long tool calls capture partial state instead of bubbling a bare throw.
export function isCommandTimeoutError(error: unknown) {
  return Boolean(
    error && typeof error === "object" && (error as { name?: unknown }).name === "TimeoutError",
  );
}

// E2B can lose the RPC watch for a still-running background command without raising its regular
// TimeoutError (which means the command exceeded timeoutMs and was killed). The observed provider
// shapes are Unknown-code SandboxErrors for a timed-out watch or an unexpectedly closed control
// socket. Those stream losses are recoverable by reconnecting or fencing the old process and
// resuming the durable engine turn; other SandboxErrors remain terminal to avoid replaying
// arbitrary command failures.
export function isRetryableCommandStreamError(error: unknown) {
  if (!(error instanceof Error) || error.name !== "SandboxError") return false;

  const message = error.message.trim();
  return (
    /^2:\s*\[unknown\]\s+the operation timed out\.?$/i.test(message) ||
    /^2:\s*\[unknown\]\s+the socket connection was closed unexpectedly\.(?:\s+For more information, pass `verbose:\s*true` in the second argument to fetch\(\))?$/i.test(
      message,
    )
  );
}

// Sandbox create/connect uses the E2B control plane, which can reject healthy durable sessions
// during capacity pressure, rate limiting, or a network timeout. Keep this policy scoped to
// acquisition: the same broad errors during filesystem or command execution can be application
// failures and must not replay a turn automatically.
export function isRetryableSandboxAcquisitionError(error: unknown) {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "RateLimitError") return true;
  if (error.name === "AbortError") return true;
  if (error.name === "TypeError" && /fetch failed|network|socket/i.test(error.message)) return true;
  if (error.name !== "SandboxError") return false;

  const status = Number.parseInt(error.message.match(/^(\d{3}):/)?.[1] ?? "", 10);
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isSandboxNotFound(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.name === "SandboxNotFoundError" || /not found|404/i.test(error.message);
}
