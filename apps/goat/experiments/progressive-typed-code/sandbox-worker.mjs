import vm from "node:vm";

if (typeof process.send !== "function") {
  throw new Error("sandbox-worker must run as a Node child process with an IPC channel");
}

let nextRequestId = 1;
const pending = new Map();

process.on("message", (message) => {
  if (message?.type === "init") {
    void execute(message.config);
    return;
  }
  if (message?.type !== "rpc_result") return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok) {
    waiter.resolve(message.value);
    return;
  }
  const error = new Error(message.error || "Sandbox tool RPC failed.");
  error.catalogKind = message.kind;
  waiter.reject(error);
});

function invoke(config, path, input) {
  if (pending.size >= config.maxPendingCalls) {
    return Promise.reject(
      new Error(`Too many concurrent tool calls (max ${config.maxPendingCalls}).`),
    );
  }
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send({
      type: "rpc",
      id,
      method: "invoke",
      payload: { path, input },
    });
  });
}

async function execute(config) {
  const toolsTarget = Object.create(null);
  Object.freeze(toolsTarget);
  const tools = new Proxy(toolsTarget, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (typeof property !== "string") return undefined;
      return async (input) => invoke(config, property, input);
    },
    set() {
      throw new Error("The tools API is read-only.");
    },
    ownKeys() {
      throw new Error("The tools API cannot be enumerated; use only loaded contract paths.");
    },
  });

  const logs = [];
  let logChars = 0;
  function recordLog(level, values) {
    if (logs.length >= config.maxLogEntries) return;
    const remaining = config.maxLogChars - logChars;
    if (remaining <= 0) return;
    const safeValues = values.map((value) => snapshotLogValue(value, remaining));
    logChars += JSON.stringify(safeValues).length;
    logs.push({ level, values: safeValues });
  }
  const sandboxConsole = Object.freeze({
    log: (...values) => recordLog("log", values),
    warn: (...values) => recordLog("warn", values),
    error: (...values) => recordLog("error", values),
  });

  const context = vm.createContext(Object.freeze({ tools, console: sandboxConsole }), {
    name: "goat-progressive-typed-code-spike",
    codeGeneration: { strings: false, wasm: false },
  });
  const started = performance.now();
  try {
    const source = `"use strict";\n(async () => {\n${config.code}\n})()`;
    const script = new vm.Script(source, {
      filename: "model-generated-code.js",
      displayErrors: true,
    });
    const value = await script.runInContext(context, {
      timeout: config.syncTimeoutMs,
      displayErrors: true,
      breakOnSigint: true,
    });
    process.send({
      type: "result",
      ok: true,
      value,
      logs,
      durationMs: performance.now() - started,
    });
  } catch (error) {
    process.send({
      type: "result",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.slice(0, 4000) : undefined,
      failureKind:
        error?.name === "SyntaxError"
          ? "syntax"
          : error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
            ? "timeout"
            : error?.catalogKind === "policy"
              ? "policy"
              : error?.catalogKind === "unknown_tool"
                ? "unknown_tool"
                : error?.catalogKind === "invalid_input"
                  ? "invalid_input"
                  : error?.catalogKind === "tool_error"
                    ? "tool_error"
                    : "runtime",
      logs,
      durationMs: performance.now() - started,
    });
  }
}

function snapshotLogValue(value, remaining) {
  const limit = Math.max(0, Math.min(2_000, remaining));
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return String(value).slice(0, limit);
    if (serialized.length <= limit) return JSON.parse(serialized);
    return `${serialized.slice(0, limit)}…`;
  } catch {
    return String(value).slice(0, limit);
  }
}
