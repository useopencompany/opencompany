import { type ChildProcess, fork, type Serializable } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CatalogError, CatalogService } from "../code-tool-interface/catalog-service";
import { findCatalogTool, toolEffect } from "./contracts";
import type {
  PolicyTraceEvent,
  ProgressiveSandboxFailureKind,
  ProgressiveSandboxResult,
} from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CODE_CHARS = 30_000;
const MAX_RESULT_CHARS = 250_000;

type WorkerRpcMessage = {
  type: "rpc";
  id: number;
  method: "invoke";
  payload: Record<string, unknown>;
};

type WorkerResultMessage = {
  type: "result";
  ok: boolean;
  value?: unknown;
  error?: string;
  stack?: string;
  failureKind?: ProgressiveSandboxFailureKind;
  logs: ProgressiveSandboxResult["logs"];
  durationMs: number;
};

export async function runProgressiveSandbox(input: {
  code: string;
  catalog: CatalogService;
  allowedPaths: ReadonlySet<string>;
  allowSideEffects: boolean;
  timeoutMs?: number;
  maxToolCalls?: number;
}): Promise<ProgressiveSandboxResult> {
  const started = performance.now();
  const code = stripCodeFence(input.code).trim();
  if (!code) return failure("runtime", "execute.code must not be empty.", started);
  if (code.length > MAX_CODE_CHARS) {
    return failure("runtime", `execute.code exceeds ${MAX_CODE_CHARS} characters.`, started);
  }

  const timeoutMs = Math.max(100, Math.min(30_000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const maxToolCalls = Math.max(1, Math.min(30, input.maxToolCalls ?? 12));
  const worker = fork(resolveWorkerPath(), [], {
    execPath: "node",
    execArgv: ["--max-old-space-size=32", "--stack-size=4096"],
    env: {
      NODE_ENV: process.env.NODE_ENV ?? "development",
      PATH: process.env.PATH ?? "",
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const policyTrace: PolicyTraceEvent[] = [];
  const writeCounts = new Map<string, number>();
  let invocationCount = 0;

  return await new Promise<ProgressiveSandboxResult>((resolveResult) => {
    let settled = false;
    const finish = (result: ProgressiveSandboxResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.kill("SIGKILL");
      resolveResult(result);
    };
    const timer = setTimeout(() => {
      finish(withPolicy(failure("timeout", `Sandbox exceeded ${timeoutMs}ms.`, started)));
    }, timeoutMs);

    worker.on("message", (message: WorkerRpcMessage | WorkerResultMessage) => {
      if (message.type === "rpc") {
        void handleInvocation(message);
        return;
      }
      const serializedSize = safeJsonSize(message);
      if (serializedSize > MAX_RESULT_CHARS) {
        finish(
          withPolicy(
            failure("protocol", `Sandbox result exceeds ${MAX_RESULT_CHARS} characters.`, started),
          ),
        );
        return;
      }
      finish(
        withPolicy({
          ok: message.ok,
          ...(message.value !== undefined ? { value: message.value } : {}),
          ...(message.error ? { error: message.error } : {}),
          ...(message.stack ? { stack: message.stack } : {}),
          ...(message.failureKind ? { failureKind: message.failureKind } : {}),
          logs: Array.isArray(message.logs) ? message.logs : [],
          durationMs: round(message.durationMs),
          invocationCount: 0,
          policyTrace: [],
        }),
      );
    });
    worker.on("error", (error) => {
      finish(
        withPolicy(
          failure("runtime", error instanceof Error ? error.message : String(error), started),
        ),
      );
    });
    worker.on("exit", (exitCode) => {
      if (!settled && exitCode !== 0) {
        finish(
          withPolicy(failure("runtime", `Sandbox worker exited with code ${exitCode}.`, started)),
        );
      }
    });
    sendIpc(worker, {
      type: "init",
      config: {
        code,
        maxPendingCalls: Math.min(maxToolCalls, 12),
        maxLogEntries: 100,
        maxLogChars: 20_000,
        syncTimeoutMs: Math.min(timeoutMs, 2_000),
      },
    });

    async function handleInvocation(message: WorkerRpcMessage) {
      try {
        const path = requireString(message.payload.path, "tool invocation path");
        if (invocationCount >= maxToolCalls) {
          deny(path, `Execution exceeded the ${maxToolCalls}-call capability budget.`);
        }
        if (!input.allowedPaths.has(path)) {
          deny(path, `Tool ${path} was not loaded by progressive discovery.`);
        }
        const tool = findCatalogTool(path);
        if (!tool) deny(path, `Tool ${path} is not present in the catalog.`);
        const effect = toolEffect(tool!.operation);
        if (effect === "write" && !input.allowSideEffects) {
          deny(path, `Side-effecting tool ${path} is not approved for this execution.`);
        }
        if (effect === "write" && (writeCounts.get(path) ?? 0) >= 1) {
          deny(path, `Duplicate write to ${path} is blocked within one execution.`);
        }

        invocationCount += 1;
        if (effect === "write") writeCounts.set(path, (writeCounts.get(path) ?? 0) + 1);
        policyTrace.push({
          at: new Date().toISOString(),
          path,
          decision: "allow",
          reason: "Path was loaded and is within the execution capability budget.",
          effect,
        });
        const value = await input.catalog.invoke(path, message.payload.input);
        sendIpc(worker, {
          type: "rpc_result",
          id: message.id,
          ok: true,
          value,
        });
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        const kind =
          error instanceof PolicyError
            ? "policy"
            : error instanceof CatalogError
              ? error.kind
              : "protocol";
        sendIpc(worker, {
          type: "rpc_result",
          id: message.id,
          ok: false,
          error: errorText,
          kind,
        });
      }
    }

    function deny(path: string, reason: string): never {
      policyTrace.push({
        at: new Date().toISOString(),
        path,
        decision: "deny",
        reason,
      });
      throw new PolicyError(reason);
    }

    function withPolicy(result: ProgressiveSandboxResult): ProgressiveSandboxResult {
      return { ...result, invocationCount, policyTrace: [...policyTrace] };
    }
  });
}

class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

function resolveWorkerPath() {
  const candidates = [
    resolve(process.cwd(), "experiments/progressive-typed-code/sandbox-worker.mjs"),
    resolve(process.cwd(), "apps/goat/experiments/progressive-typed-code/sandbox-worker.mjs"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error("Could not resolve progressive typed-code sandbox worker.");
  return path;
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

function failure(
  failureKind: ProgressiveSandboxFailureKind,
  error: string,
  started: number,
): ProgressiveSandboxResult {
  return {
    ok: false,
    error,
    failureKind,
    logs: [],
    durationMs: round(performance.now() - started),
    invocationCount: 0,
    policyTrace: [],
  };
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
