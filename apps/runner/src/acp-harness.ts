import type { Harness } from "@opencompany/agent-runtime";
import { CodexChatRetryableInfrastructureError } from "./codex-chat-errors";
import { commandExitResult, type SandboxHandle } from "./sandbox";

const ACP_REQUEST_TIMEOUT_MS = 30_000;
const ACP_ABORT_POLL_INTERVAL_MS = 500;
const ACP_CANCEL_GRACE_MS = 5_000;
const ACP_STDERR_TAIL_LIMIT = 4_000;
const ACP_FAILURE_DIAGNOSTIC_LIMIT = 2_000;
const ACP_COMMAND_STREAM_RECONNECT_ATTEMPTS = 3;

export type AcpMcpServer =
  | {
      name: string;
      type: "http" | "sse";
      url: string;
      headers: Array<{ name: string; value: string }>;
    }
  | {
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
    };

export type AcpPermissionRequest = {
  id: number | string;
  method: "session/request_permission";
  params: Record<string, unknown>;
};

export type AcpPermissionResponse = {
  outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string };
};

export type AcpElicitationRequest = {
  id: number | string;
  method: "elicitation/create";
  params: Record<string, unknown>;
};

export type AcpElicitationResponse = {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown> | null;
  _meta?: Record<string, unknown> | null;
};

export type AcpPromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; name: string; uri: string; mimeType?: string };

export type AcpEngineAdapter = {
  id: string;
  displayName: string;
  command: (workdir: string) => string;
  prepareSession?: (input: { mcpServers: AcpMcpServer[] }) => {
    mcpServers?: AcpMcpServer[];
    meta?: Record<string, unknown> | null;
  };
  configOptions: {
    model?: string;
    reasoningEffort?: {
      id: string;
      value: (effort: string) => string;
    };
    permissionMode?: {
      id: string;
      values: Record<"default" | "bypassPermissions", string>;
    };
    collaborationMode?: {
      id: string;
      values: Record<"default" | "plan", string>;
    };
  };
  steeringControlMethod?: string;
};

export type AcpExtensionRequest = {
  method: string;
  params: Record<string, unknown>;
};

export type AcpHarnessTurnInput = {
  adapter: AcpEngineAdapter;
  sandbox: SandboxHandle;
  workdir: string;
  task: string;
  prepareFreshTask: () => Promise<string>;
  existingSessionId: string | null;
  mcpServers: AcpMcpServer[];
  envs: Record<string, string>;
  timeoutMs: number;
  redact: (value: string) => string;
  checkAbort: () => Promise<void>;
  onRuntimeEvents: (events: Record<string, unknown>[]) => Promise<void>;
  onEngineSessionId: (sessionId: string) => Promise<void>;
  onExistingSessionInvalidated: () => Promise<void>;
  onEngineStopped?: () => Promise<void>;
  onPermissionRequest: (request: AcpPermissionRequest) => Promise<AcpPermissionResponse>;
  onElicitationRequest?: (request: AcpElicitationRequest) => Promise<AcpElicitationResponse>;
  prompt?: AcpPromptBlock[];
  prepareFreshPrompt?: () => Promise<AcpPromptBlock[]>;
  extensionRequests?: AcpExtensionRequest[];
  model?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: "default" | "bypassPermissions";
  collaborationMode?: "default" | "plan";
  goal?: { objective: string; tokenBudget?: number | null } | null;
  steering?: AsyncIterable<AcpPromptBlock[]>;
};

export type AcpHarnessTurnResult = {
  sessionId: string;
  loadedSession: boolean;
  promptResponse: Record<string, unknown>;
  stderrTail: string;
};

export class AcpHarness implements Harness<AcpHarnessTurnInput, AcpHarnessTurnResult> {
  async runTurn(input: AcpHarnessTurnInput): Promise<AcpHarnessTurnResult> {
    let projectUpdates = false;
    const client = new AcpJsonRpcClient({
      sandbox: input.sandbox,
      adapterName: input.adapter.displayName,
      command: input.adapter.command(input.workdir),
      envs: input.envs,
      redact: input.redact,
      onNotification: async (notification) => {
        if (projectUpdates && notification.method === "session/update") {
          await input.onRuntimeEvents([notification]);
        }
      },
      onServerRequest: async (request) => {
        if (request.method === "session/request_permission") {
          return input.onPermissionRequest({
            id: request.id,
            method: "session/request_permission",
            params: request.params,
          });
        }
        if (request.method === "elicitation/create") {
          if (!input.onElicitationRequest) return { action: "cancel" };
          return input.onElicitationRequest({
            id: request.id,
            method: "elicitation/create",
            params: request.params,
          });
        }
        throw new AcpRpcError(-32601, `Unsupported ACP client method: ${request.method}`);
      },
    });

    await client.start();
    try {
      const initialized = await client.request("initialize", {
        protocolVersion: 1,
        clientInfo: {
          name: "opencompany-runner",
          title: "opencompany runner",
          version: "0.2.0",
        },
        clientCapabilities: {
          terminal: false,
          elicitation: { form: {}, url: {} },
          session: { configOptions: { boolean: {} } },
          auth: { _meta: { gateway: true } },
          _meta: { "subagent-transcript": true },
        },
      });
      const initializedRecord = readRecord(initialized);
      const capabilities = readRecord(initializedRecord?.agentCapabilities) ?? {};
      const goalControlMethod = readGoalControlMethod(initializedRecord);
      for (const request of input.extensionRequests ?? []) {
        await client.request(request.method, request.params);
      }
      const preparedSession = input.adapter.prepareSession?.({ mcpServers: input.mcpServers });
      const sessionParams = {
        cwd: input.workdir,
        mcpServers: preparedSession?.mcpServers ?? input.mcpServers,
        ...(preparedSession?.meta ? { _meta: preparedSession.meta } : {}),
      };

      let loadedSession = false;
      let sessionId = input.existingSessionId;
      let task = input.task;
      let prompt = input.prompt ?? textPrompt(input.task);
      let sessionResponse: Record<string, unknown> | null = null;
      if (sessionId && capabilities.loadSession === true) {
        try {
          sessionResponse = readRecord(
            await client.request("session/load", { ...sessionParams, sessionId }),
          );
          loadedSession = true;
        } catch (error) {
          // A transport-level failure (adapter process died, RPC timeout, adapter not running)
          // means the connection itself is unusable — session/new cannot succeed on it either — so
          // abort the turn and let the worker settle or retry. Any application-level JSON-RPC error
          // (AcpRpcError: -32603 "Internal error", -32002 missing session, "no rollout found for
          // thread id …", …) means the saved thread cannot be resumed on this (freshly-fenced)
          // process; invalidate it and fall through to session/new so this turn proceeds and the
          // next turn is never poisoned by the same thread id.
          if (!(error instanceof AcpRpcError)) throw error;
          await input.onExistingSessionInvalidated();
          sessionId = null;
          task = await input.prepareFreshTask();
          prompt = input.prepareFreshPrompt ? await input.prepareFreshPrompt() : textPrompt(task);
        }
      } else if (sessionId) {
        await input.onExistingSessionInvalidated();
        sessionId = null;
        task = await input.prepareFreshTask();
        prompt = input.prepareFreshPrompt ? await input.prepareFreshPrompt() : textPrompt(task);
      }

      if (!sessionId) {
        const created = readRecord(await client.request("session/new", sessionParams));
        sessionId = readString(created?.sessionId);
        if (!sessionId) throw new Error("ACP session/new returned no session id.");
        sessionResponse = created;
      }
      await input.onEngineSessionId(sessionId);
      await configureSession(client, input.adapter, sessionId, sessionResponse, {
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        permissionMode: input.permissionMode,
        collaborationMode: input.collaborationMode,
      });
      // session/load replays historical updates. Drain those (and any config notifications)
      // while projection is still disabled so a reclaimed turn only renders new output.
      await client.flush();

      projectUpdates = true;
      await input.onRuntimeEvents([{ method: "session/started", params: { sessionId } }]);
      // Setting a Goal can itself run a backend turn before the control request returns. Treat it
      // as execution, and share one deadline with the ordinary prompt that follows.
      const executionDeadline = Date.now() + input.timeoutMs;
      if (input.goal && goalControlMethod) {
        await requestGoalWithAbort({
          client,
          input,
          sessionId,
          deadline: executionDeadline,
          controlMethod: goalControlMethod,
          goal: input.goal,
        });
      }
      const promptResponse = await requestPromptWithAbort({
        client,
        input,
        sessionId,
        prompt,
        deadline: executionDeadline,
      });
      await client.flush();
      await input.onRuntimeEvents([
        {
          method: "session/prompt_result",
          params: {
            sessionId,
            stopReason: readString(promptResponse.stopReason) ?? "end_turn",
            ...(promptResponse.usage !== undefined ? { usage: promptResponse.usage } : {}),
          },
        },
      ]);
      return {
        sessionId,
        loadedSession,
        promptResponse,
        stderrTail: client.stderrTail(),
      };
    } finally {
      try {
        await client.stop();
      } finally {
        await input.onEngineStopped?.();
      }
    }
  }
}

async function configureSession(
  client: AcpJsonRpcClient,
  adapter: AcpEngineAdapter,
  sessionId: string,
  sessionResponse: Record<string, unknown> | null,
  input: {
    model: string | null | undefined;
    reasoningEffort: string | null | undefined;
    permissionMode: "default" | "bypassPermissions" | undefined;
    collaborationMode: "default" | "plan" | undefined;
  },
) {
  const optionIds = new Set(
    (Array.isArray(sessionResponse?.configOptions) ? sessionResponse.configOptions : []).flatMap(
      (value) => {
        const id = readString(readRecord(value)?.id);
        return id ? [id] : [];
      },
    ),
  );
  const config = adapter.configOptions;
  const requested = [
    { configId: config.model, value: input.model },
    {
      configId: config.reasoningEffort?.id,
      value:
        input.reasoningEffort && config.reasoningEffort
          ? config.reasoningEffort.value(input.reasoningEffort)
          : null,
    },
    {
      configId: config.permissionMode?.id,
      value:
        input.permissionMode && config.permissionMode
          ? config.permissionMode.values[input.permissionMode]
          : null,
    },
    {
      configId: config.collaborationMode?.id,
      value:
        input.collaborationMode && config.collaborationMode
          ? config.collaborationMode.values[input.collaborationMode]
          : null,
    },
  ];
  for (const option of requested) {
    if (!option.configId || !option.value || !optionIds.has(option.configId)) continue;
    await client.request("session/set_config_option", {
      sessionId,
      configId: option.configId,
      value: option.value,
    });
  }
}

async function requestPromptWithAbort(input: {
  client: AcpJsonRpcClient;
  input: AcpHarnessTurnInput;
  sessionId: string;
  prompt: AcpPromptBlock[];
  deadline: number;
}) {
  const requestTimeoutMs = Math.max(1, input.deadline - Date.now()) + ACP_CANCEL_GRACE_MS;
  const outcome = input.client
    .request(
      "session/prompt",
      {
        sessionId: input.sessionId,
        prompt: input.prompt,
      },
      requestTimeoutMs,
    )
    .then(
      (value) => ({ type: "prompt" as const, ok: true as const, value: readRecord(value) ?? {} }),
      (error) => ({ type: "prompt" as const, ok: false as const, error }),
    );
  const steeringIterator = input.input.steering?.[Symbol.asyncIterator]();
  let nextSteering = steeringIterator
    ?.next()
    .then((value) => ({ type: "steering" as const, value }));
  while (true) {
    const settled = await Promise.race([
      outcome,
      ...(nextSteering ? [nextSteering] : []),
      new Promise<{ type: "tick" }>((resolve) =>
        setTimeout(() => resolve({ type: "tick" }), ACP_ABORT_POLL_INTERVAL_MS),
      ),
    ]);
    if (settled.type === "prompt") {
      await steeringIterator?.return?.();
      if (settled.ok) return settled.value;
      throw settled.error;
    }
    if (settled.type === "steering") {
      if (settled.value.done) {
        nextSteering = undefined;
        continue;
      }
      const steeringMethod = input.input.adapter.steeringControlMethod;
      if (!steeringMethod) {
        throw new Error(`${input.input.adapter.displayName} does not advertise ACP steering.`);
      }
      const response = readRecord(
        await input.client.request(steeringMethod, {
          sessionId: input.sessionId,
          prompt: settled.value.value,
        }),
      );
      if (response?.outcome === "failed") {
        throw new Error(`${input.input.adapter.displayName} could not steer the active ACP turn.`);
      }
      nextSteering = steeringIterator
        ?.next()
        .then((value) => ({ type: "steering" as const, value }));
      continue;
    }

    let abortError: unknown = null;
    try {
      await input.input.checkAbort();
    } catch (error) {
      abortError = error;
    }
    if (!abortError && Date.now() >= input.deadline) {
      abortError = new Error(`${input.input.adapter.displayName} ACP turn timed out.`);
    }
    if (!abortError) continue;

    await input.client.notify("session/cancel", { sessionId: input.sessionId }).catch(() => {});
    await Promise.race([
      outcome,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ACP_CANCEL_GRACE_MS)),
    ]);
    await input.client.flush().catch(() => {});
    await steeringIterator?.return?.();
    throw abortError;
  }
}

async function requestGoalWithAbort(input: {
  client: AcpJsonRpcClient;
  input: AcpHarnessTurnInput;
  sessionId: string;
  deadline: number;
  controlMethod: string;
  goal: { objective: string; tokenBudget?: number | null };
}) {
  const requestTimeoutMs = Math.max(1, input.deadline - Date.now()) + ACP_CANCEL_GRACE_MS;
  const outcome = input.client
    .request(
      input.controlMethod,
      {
        sessionId: input.sessionId,
        action: "set",
        objective: input.goal.objective,
        ...(input.goal.tokenBudget != null ? { tokenBudget: input.goal.tokenBudget } : {}),
      },
      requestTimeoutMs,
    )
    .then(
      (value) => ({ ok: true as const, value: readRecord(value) ?? {} }),
      (error) => ({ ok: false as const, error }),
    );

  while (true) {
    const settled = await Promise.race([
      outcome,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ACP_ABORT_POLL_INTERVAL_MS)),
    ]);
    if (settled) {
      if (settled.ok) return settled.value;
      throw settled.error;
    }

    let abortError: unknown = null;
    try {
      await input.input.checkAbort();
    } catch (error) {
      abortError = error;
    }
    if (!abortError && Date.now() >= input.deadline) {
      abortError = new Error(`${input.input.adapter.displayName} ACP turn timed out.`);
    }
    if (!abortError) continue;

    await input.client.notify("session/cancel", { sessionId: input.sessionId }).catch(() => {});
    await Promise.race([
      outcome,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ACP_CANCEL_GRACE_MS)),
    ]);
    await input.client.flush().catch(() => {});
    throw abortError;
  }
}

function readGoalControlMethod(initialized: Record<string, unknown> | null) {
  const goal = readRecord(readRecord(initialized?._meta)?.goal);
  if (goal?.version !== 1) return null;
  const actions = Array.isArray(goal.actions) ? goal.actions : [];
  if (!actions.includes("set")) return null;
  return readString(goal.controlMethod);
}

type AcpJsonRpcRequest = {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
};

type AcpJsonRpcNotification = {
  method: string;
  params: Record<string, unknown>;
};

class AcpJsonRpcClient {
  private buffer = "";
  private nextId = 1;
  private handle: unknown = null;
  private stopping = false;
  private failure: Error | null = null;
  private lastStderr = "";
  private processing: Promise<void> = Promise.resolve();
  private watchGeneration = 0;
  private readonly pending = new Map<
    number | string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly input: {
      sandbox: SandboxHandle;
      adapterName: string;
      command: string;
      envs: Record<string, string>;
      redact: (value: string) => string;
      onNotification: (notification: AcpJsonRpcNotification) => Promise<void>;
      onServerRequest: (request: AcpJsonRpcRequest) => Promise<Record<string, unknown>>;
    },
  ) {}

  async start() {
    this.handle = await this.input.sandbox.commands.run(this.input.command, {
      background: true,
      stdin: true,
      envs: this.input.envs,
      timeoutMs: 0,
      onStdout: (data: string) => {
        this.consumeStdout(data);
      },
      onStderr: (data: string) => {
        this.lastStderr = (this.lastStderr + this.input.redact(data)).slice(-ACP_STDERR_TAIL_LIMIT);
      },
    });
    this.watch(this.handle);
  }

  async stop() {
    this.stopping = true;
    const pid = commandHandlePid(this.handle);
    if (pid != null) await this.input.sandbox.commands.kill(pid).catch(() => false);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`${this.input.adapterName} ACP adapter stopped before responding.`));
    }
    this.pending.clear();
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = ACP_REQUEST_TIMEOUT_MS) {
    this.throwIfFailed();
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const suffix = this.lastStderr.trim()
          ? ` Last stderr: ${lastLine(this.lastStderr.trim())}`
          : "";
        reject(new Error(`ACP request "${method}" timed out.${suffix}`));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, { resolve, reject, timeout });
    });
    void this.send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pending.reject(asError(error));
      this.pending.delete(id);
    });
    return response;
  }

  notify(method: string, params: Record<string, unknown>) {
    return this.send({ jsonrpc: "2.0", method, params });
  }

  async flush() {
    await this.processing;
    this.throwIfFailed();
  }

  stderrTail() {
    return this.lastStderr;
  }

  private consumeStdout(data: string) {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.consumeLine(line);
  }

  private consumeLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    const record = readRecord(message);
    if (!record) return;
    const id = typeof record.id === "number" || typeof record.id === "string" ? record.id : null;
    const method = readString(record.method);
    if (id != null && method) {
      void this.handleServerRequest({
        id,
        method,
        params: readRecord(record.params) ?? {},
      });
      return;
    }
    if (id != null) {
      this.resolveResponse(id, record);
      return;
    }
    if (!method) return;
    const notification = { method, params: readRecord(record.params) ?? {} };
    this.processing = this.processing
      .then(() => this.input.onNotification(notification))
      .catch((error) => this.fail(asError(error)));
  }

  private async handleServerRequest(request: AcpJsonRpcRequest) {
    try {
      const result = await this.input.onServerRequest(request);
      await this.send({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      const rpcError =
        error instanceof AcpRpcError ? error : new AcpRpcError(-32000, asError(error).message);
      await this.send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: rpcError.code, message: rpcError.message },
      }).catch(() => {});
    }
  }

  private resolveResponse(id: number | string, response: Record<string, unknown>) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    const error = readRecord(response.error);
    if (error) {
      pending.reject(
        new AcpRpcError(
          typeof error.code === "number" ? error.code : -32000,
          readString(error.message) ?? "ACP request failed.",
        ),
      );
      return;
    }
    pending.resolve(response.result);
  }

  private async send(message: Record<string, unknown>) {
    this.throwIfFailed();
    const pid = commandHandlePid(this.handle);
    if (pid == null) throw new Error(`${this.input.adapterName} ACP adapter is not running.`);
    const data = `${JSON.stringify(message)}\n`;
    const handle = this.handle as { sendStdin?: (value: string) => Promise<void> };
    if (typeof handle.sendStdin === "function") {
      await handle.sendStdin(data);
      return;
    }
    await this.input.sandbox.commands.sendStdin(pid, data);
  }

  private watch(handle: unknown) {
    const wait = readRecord(handle)?.wait;
    if (typeof wait !== "function") return;
    const generation = ++this.watchGeneration;
    void (wait as () => Promise<unknown>).call(handle).then(
      () => {
        if (!this.stopping && generation === this.watchGeneration) {
          this.fail(new Error(`${this.input.adapterName} ACP adapter exited unexpectedly.`));
        }
      },
      (error) => {
        if (this.stopping || generation !== this.watchGeneration) return;
        const watchError = asError(error);
        if (commandExitResult(watchError)) {
          this.fail(watchError);
          return;
        }
        // Application failures arrive as JSON-RPC error responses. A rejected command watch is
        // therefore a transport failure regardless of the SDK error class or message spelling,
        // except for an explicit non-zero adapter exit reported by the command handle itself.
        void this.reconnect(handle, generation, watchError);
      },
    );
  }

  private async reconnect(handle: unknown, generation: number, streamError: Error) {
    const pid = commandHandlePid(handle);
    if (pid == null) {
      this.fail(this.retryableStreamFailure(streamError));
      return;
    }

    for (let attempt = 1; attempt <= ACP_COMMAND_STREAM_RECONNECT_ATTEMPTS; attempt += 1) {
      if (this.stopping || generation !== this.watchGeneration) return;
      try {
        const connected = await this.input.sandbox.commands.connect(pid, {
          timeoutMs: 0,
          onStdout: (data: string) => {
            this.consumeStdout(data);
          },
          onStderr: (data: string) => {
            this.lastStderr = (this.lastStderr + this.input.redact(data)).slice(
              -ACP_STDERR_TAIL_LIMIT,
            );
          },
        });
        if (this.stopping || generation !== this.watchGeneration) {
          await connected.disconnect().catch(() => undefined);
          return;
        }
        this.handle = connected;
        this.watch(connected);
        return;
      } catch {
        // The original stream error is the actionable failure: it preserves the durable-turn
        // retry classification if the adapter process cannot be reattached.
      }
    }
    if (!this.stopping && generation === this.watchGeneration) {
      this.fail(this.retryableStreamFailure(streamError));
    }
  }

  private retryableStreamFailure(cause: Error) {
    return new CodexChatRetryableInfrastructureError(
      `${this.input.adapterName} lost contact with its sandbox command stream before the turn completed.`,
      cause,
      `[run_turn] ${cause.name}: ${this.input.redact(cause.message)}`.slice(
        0,
        ACP_FAILURE_DIAGNOSTIC_LIMIT,
      ),
    );
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private throwIfFailed() {
    if (this.failure) throw this.failure;
  }
}

class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "AcpRpcError";
  }
}

function commandHandlePid(handle: unknown) {
  const pid = readRecord(handle)?.pid;
  return typeof pid === "number" && Number.isInteger(pid) ? pid : null;
}

function asError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}

function lastLine(value: string) {
  return value.split(/\r?\n/).filter(Boolean).at(-1) ?? value;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function textPrompt(task: string): AcpPromptBlock[] {
  return [{ type: "text", text: task }];
}
