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

function rpc(config, method, payload) {
  if (pending.size >= config.maxPendingCalls) {
    return Promise.reject(
      new Error(`Too many concurrent tool calls (max ${config.maxPendingCalls}).`),
    );
  }
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send({ type: "rpc", id, method, payload });
  });
}

async function execute(config) {
  const toolsTarget = Object.create(null);
  Object.defineProperties(toolsTarget, {
    search: {
      enumerable: true,
      value: async (query, options = {}) =>
        rpc(config, "search", {
          query,
          limit: typeof options?.limit === "number" ? options.limit : 5,
        }),
    },
    describe: {
      enumerable: true,
      value: async (path) => rpc(config, "describe", { path }),
    },
  });
  Object.freeze(toolsTarget);

  const tools = new Proxy(toolsTarget, {
    get(target, property) {
      if (property === "then") return undefined;
      if (Reflect.has(target, property)) return Reflect.get(target, property);
      if (typeof property !== "string") return undefined;
      return async (input) => rpc(config, "invoke", { path: property, input });
    },
    set() {
      throw new Error("The tools API is read-only.");
    },
  });

  const logs = [];
  function recordLog(level, values) {
    if (logs.length >= config.maxLogEntries) return;
    logs.push({ level, values });
  }

  const sandboxConsole = Object.freeze({
    log: (...values) => recordLog("log", values),
    warn: (...values) => recordLog("warn", values),
    error: (...values) => recordLog("error", values),
  });

  const context = vm.createContext(Object.freeze({ tools, console: sandboxConsole }), {
    name: "goat-code-tool-interface-spike",
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
