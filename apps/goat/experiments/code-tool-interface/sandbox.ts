import { type ChildProcess, fork, type Serializable } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CatalogError, CatalogService } from "./catalog-service";
import type { SandboxFailureKind, SandboxResult } from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CODE_CHARS = 30_000;
const MAX_RESULT_CHARS = 250_000;

type WorkerRpcMessage = {
  type: "rpc";
  id: number;
  method: "search" | "describe" | "invoke";
  payload: Record<string, unknown>;
};

type WorkerResultMessage = SandboxResult & { type: "result" };

export async function runSandbox(input: {
  code: string;
  catalog: CatalogService;
  timeoutMs?: number;
}): Promise<SandboxResult> {
  const started = performance.now();
  const code = stripCodeFence(input.code).trim();
  if (!code) return failure("runtime", "execute.code must not be empty.", started);
  if (code.length > MAX_CODE_CHARS) {
    return failure("runtime", `execute.code exceeds ${MAX_CODE_CHARS} characters.`, started);
  }

  const timeoutMs = Math.max(100, Math.min(30_000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const worker = fork(resolveWorkerPath(), [], {
    execPath: "node",
    execArgv: ["--max-old-space-size=32", "--stack-size=4096"],
    env: { NODE_ENV: process.env.NODE_ENV ?? "development", PATH: process.env.PATH ?? "" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });

  return await new Promise<SandboxResult>((resolve) => {
    let settled = false;
    const finish = (result: SandboxResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.kill("SIGKILL");
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish(failure("timeout", `Sandbox exceeded ${timeoutMs}ms.`, started));
    }, timeoutMs);

    worker.on("message", (message: WorkerRpcMessage | WorkerResultMessage) => {
      if (message.type === "rpc") {
        void handleRpc(worker, input.catalog, message);
        return;
      }
      const serializedSize = safeJsonSize(message.value);
      if (serializedSize > MAX_RESULT_CHARS) {
        finish(
          failure("protocol", `Sandbox result exceeds ${MAX_RESULT_CHARS} characters.`, started),
        );
        return;
      }
      finish({
        ok: message.ok,
        ...(message.value !== undefined ? { value: message.value } : {}),
        ...(message.error ? { error: message.error } : {}),
        ...(message.stack ? { stack: message.stack } : {}),
        ...(message.failureKind ? { failureKind: message.failureKind } : {}),
        logs: Array.isArray(message.logs) ? message.logs : [],
        durationMs: Math.round(message.durationMs * 1000) / 1000,
      });
    });
    worker.on("error", (error) => {
      finish(failure("runtime", error instanceof Error ? error.message : String(error), started));
    });
    worker.on("exit", (code) => {
      if (!settled && code !== 0) {
        finish(failure("runtime", `Sandbox worker exited with code ${code}.`, started));
      }
    });
    sendIpc(worker, {
      type: "init",
      config: {
        code,
        maxPendingCalls: 12,
        maxLogEntries: 100,
        syncTimeoutMs: Math.min(timeoutMs, 2_000),
      },
    });
  });
}

function resolveWorkerPath() {
  const candidates = [
    resolve(process.cwd(), "experiments/code-tool-interface/sandbox-worker.mjs"),
    resolve(process.cwd(), "apps/goat/experiments/code-tool-interface/sandbox-worker.mjs"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path)
    throw new Error("Could not resolve sandbox-worker.mjs from the repository or Goat app.");
  return path;
}

async function handleRpc(worker: ChildProcess, catalog: CatalogService, message: WorkerRpcMessage) {
  try {
    let value: unknown;
    if (message.method === "search") {
      const query = requireString(message.payload.query, "tools.search query");
      const limit = typeof message.payload.limit === "number" ? message.payload.limit : 5;
      value = catalog.search(query, limit);
    } else if (message.method === "describe") {
      value = catalog.describe(requireString(message.payload.path, "tools.describe path"));
    } else {
      value = await catalog.invoke(
        requireString(message.payload.path, "tool invocation path"),
        message.payload.input,
      );
    }
    sendIpc(worker, { type: "rpc_result", id: message.id, ok: true, value });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    const kind = error instanceof CatalogError ? error.kind : "protocol";
    sendIpc(worker, { type: "rpc_result", id: message.id, ok: false, error: messageText, kind });
  }
}

function sendIpc(worker: ChildProcess, message: Serializable) {
  if (!worker.connected) return false;
  try {
    return worker.send(message);
  } catch {
    return false;
  }
}

function stripCodeFence(code: string) {
  const match = code.match(/^```(?:javascript|js|typescript|ts)?\s*\n([\s\S]*?)\n```$/i);
  return match?.[1] ?? code;
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a string.`);
  return value;
}

function safeJsonSize(value: unknown) {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function failure(failureKind: SandboxFailureKind, error: string, started: number): SandboxResult {
  return {
    ok: false,
    error,
    failureKind,
    logs: [],
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
  };
}
