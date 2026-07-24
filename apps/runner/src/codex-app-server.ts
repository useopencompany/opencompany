import { createHash } from "node:crypto";
import { shellQuote } from "@opencompany/agent-runtime";
import type { CodexReasoningEffort } from "@opencompany/agent-runtime/types";
import { createLogger } from "@opencompany/observability";
import { buildCodexConfigForAuth, type CodexCliAuth } from "./codex-tool";
import { buildGitHubCommandEnv, truncateText } from "./coding-agent-shared";
import type { SandboxHandle } from "./sandbox";

const CODEX_BIN_PATH = '"$HOME/.codex/bin"';
const CODEX_APP_SERVER_SOCKET = "app-server.sock";
const CODEX_APP_SERVER_STATE = "app-server-state.json";
const CODEX_APP_SERVER_PROXY = "app-server-proxy.mjs";
const CODEX_APP_SERVER_PROXY_STATE = "app-server-proxy-state.json";
const CODEX_APP_SERVER_DAEMON_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const CODEX_APP_SERVER_NOTIFICATION_FLUSH_MS = 100;
const CODEX_APP_SERVER_NOTIFICATION_FLUSH_CHARS = 64;
const CODEX_APP_SERVER_CLIENT_NAME = "opencompany_runner";

const logger = createLogger({ service: "opencompany-runner", runtime: "codex-app-server" });

type CodexGitHubAuth = {
  githubToken: string | null;
  githubAuthHeader: string | null;
};

type CodexUsage = {
  input_tokens: number;
  cache_read_input_tokens?: number;
  output_tokens: number;
};

export type CodexGoalModeInput = {
  objective: string;
  tokenBudget?: number | null;
};

export type CodexGoalStatus =
  | "active"
  | "paused"
  | "complete"
  | "blocked"
  | "budgetLimited"
  | "usageLimited"
  | "cleared";

export type CodexAppServerGoalSummary = {
  objective: string | null;
  status: CodexGoalStatus | null;
  tokenBudget: number | null;
  tokensUsed: number | null;
  timeUsedSeconds: number | null;
};

export type CodexAppServerSummary = {
  sessionId: string | null;
  status: "success" | "error" | "timeout" | "unknown";
  result: string;
  error: string | null;
  usage: CodexUsage | null;
  goal: CodexAppServerGoalSummary | null;
};

export type CodexAppServerLocalImage = {
  path: string;
  detail?: "high" | "original";
};

export type CodexAppServerSkill = {
  name: string;
  path: string;
};

export type CodexAppServerDynamicToolSpec = {
  type: "function";
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
};

export type CodexAppServerDynamicToolResponse = {
  success: boolean;
  contentItems: Array<
    { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }
  >;
};

export type CodexAppServerDynamicToolCall = {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
};

export type CodexAppServerDynamicTool = {
  spec: CodexAppServerDynamicToolSpec;
  execute: (call: CodexAppServerDynamicToolCall) => Promise<CodexAppServerDynamicToolResponse>;
};

type AppServerState = {
  pid: number;
  socketPath: string;
  fingerprint: string;
};

type JsonRpcResponse = {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type JsonRpcNotification = {
  method: string;
  params?: Record<string, unknown>;
};

export type CodexAppServerRequest = {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
};

export function buildCodexAppServerCommandPlan(input: {
  codexWorkRoot: string;
  codexHome: string;
  skillFingerprint: string;
  auth: CodexCliAuth;
  githubAuth: CodexGitHubAuth;
}) {
  const socketPath = `${input.codexHome}/${CODEX_APP_SERVER_SOCKET}`;
  const statePath = `${input.codexHome}/${CODEX_APP_SERVER_STATE}`;
  const proxyPath = `${input.codexHome}/${CODEX_APP_SERVER_PROXY}`;
  const proxyStatePath = `${input.codexHome}/${CODEX_APP_SERVER_PROXY_STATE}`;
  const config = buildCodexConfigForAuth(input.auth);
  const codexEnv = {
    CODEX_HOME: input.codexHome,
    ...(input.auth.kind === "api" ? { [input.auth.apiKeyEnvVar]: input.auth.apiKeyValue } : {}),
    ...(input.githubAuth.githubToken && input.githubAuth.githubAuthHeader
      ? buildGitHubCommandEnv({
          githubAuthHeader: input.githubAuth.githubAuthHeader,
          githubToken: input.githubAuth.githubToken,
          toolCallId: "codex-session",
        })
      : {}),
  };
  const daemonCommand = [
    `cd ${shellQuote(input.codexWorkRoot)}`,
    `export PATH=${CODEX_BIN_PATH}:"$PATH"`,
    `codex app-server --listen ${shellQuote(`unix://${socketPath}`)}`,
  ].join(" && ");
  const proxyCommand = [
    `cd ${shellQuote(input.codexWorkRoot)}`,
    `export PATH=${CODEX_BIN_PATH}:"$PATH"`,
    `bun ${shellQuote(proxyPath)} ${shellQuote(socketPath)}`,
  ].join(" && ");

  return {
    codexWorkRoot: input.codexWorkRoot,
    codexHome: input.codexHome,
    socketPath,
    statePath,
    proxyPath,
    proxyStatePath,
    codexEnv,
    config,
    daemonCommand,
    proxyCommand,
    fingerprint: appServerFingerprint({
      config,
      skillFingerprint: input.skillFingerprint,
      auth: input.auth,
      githubAuth: input.githubAuth,
    }),
    forceRestart: input.auth.brokered,
  };
}

export async function runCodexAppServerTurn(input: {
  sandbox: SandboxHandle;
  codexWorkRoot: string;
  codexHome: string;
  skillFingerprint: string;
  task: string;
  skills?: CodexAppServerSkill[];
  localImages?: CodexAppServerLocalImage[];
  dynamicTools?: CodexAppServerDynamicTool[];
  model: string;
  reasoningEffort: CodexReasoningEffort;
  planModeReasoningEffort: CodexReasoningEffort | null;
  goalMode?: CodexGoalModeInput | null;
  existingEngineSessionId: string | null;
  existingEngineTurnId?: string | null;
  reattachExistingTurn?: boolean;
  forceRestartForRecovery?: boolean;
  auth: CodexCliAuth;
  githubAuth: CodexGitHubAuth;
  timeoutMs: number;
  checkAbort: () => Promise<void>;
  onRuntimeEvents: (events: Record<string, unknown>[]) => Promise<void>;
  onEngineSessionId?: (threadId: string) => Promise<void>;
  onEngineTurnId?: (turnId: string) => Promise<void>;
  onRecoveryStart?: () => Promise<void>;
  onServerRequest?: (request: CodexAppServerRequest) => Promise<Record<string, unknown>>;
  onActivity: (activity: string) => Promise<void>;
  detachOnAbort?: (error: unknown) => boolean;
}) {
  const basePlan = buildCodexAppServerCommandPlan({
    codexWorkRoot: input.codexWorkRoot,
    codexHome: input.codexHome,
    skillFingerprint: input.skillFingerprint,
    auth: input.auth,
    githubAuth: input.githubAuth,
  });
  const plan = input.forceRestartForRecovery ? { ...basePlan, forceRestart: true } : basePlan;

  await ensureCodexAppServerDaemon({ sandbox: input.sandbox, plan });
  try {
    return await runTurnThroughProxy({ ...input, plan });
  } catch (error) {
    if (!isInitializeFailure(error)) throw error;
    await stopCodexAppServerDaemon(input.sandbox, plan);
    await ensureCodexAppServerDaemon({
      sandbox: input.sandbox,
      plan: { ...plan, forceRestart: true },
    });
    return await runTurnThroughProxy({ ...input, plan });
  }
}

async function ensureCodexAppServerDaemon(input: {
  sandbox: SandboxHandle;
  plan: ReturnType<typeof buildCodexAppServerCommandPlan>;
}) {
  await input.sandbox.files.write(`${input.plan.codexHome}/config.toml`, input.plan.config);
  await input.sandbox.files.write(input.plan.proxyPath, codexAppServerProxyScript());
  const current = await readAppServerState(input.sandbox, input.plan.statePath);
  const reusable =
    !input.plan.forceRestart &&
    current?.fingerprint === input.plan.fingerprint &&
    current.socketPath === input.plan.socketPath &&
    (await appServerProcessReady(input.sandbox, current));
  if (reusable) {
    logger.info("Reusing Codex app-server daemon", {
      event: "opencompany.codex_app_server_daemon_reused",
      pid: current.pid,
    });
    return;
  }

  logger.info("Starting Codex app-server daemon", {
    event: "opencompany.codex_app_server_daemon_starting",
    force_restart: input.plan.forceRestart,
    had_state: Boolean(current),
  });
  await stopCodexAppServerDaemon(input.sandbox, input.plan, current?.pid ?? null);
  const handle = await input.sandbox.commands.run(input.plan.daemonCommand, {
    background: true,
    envs: input.plan.codexEnv,
    timeoutMs: CODEX_APP_SERVER_DAEMON_TIMEOUT_MS,
  });
  const pid = commandHandlePid(handle);
  if (pid == null) throw new Error("Codex app-server did not return a process id.");
  await waitForEndpoint(input.sandbox, input.plan.socketPath);
  await input.sandbox.files.write(
    input.plan.statePath,
    JSON.stringify({
      pid,
      socketPath: input.plan.socketPath,
      fingerprint: input.plan.fingerprint,
    } satisfies AppServerState),
  );
  logger.info("Started Codex app-server daemon", {
    event: "opencompany.codex_app_server_daemon_started",
    pid,
  });
}

async function stopCodexAppServerDaemon(
  sandbox: SandboxHandle,
  plan: ReturnType<typeof buildCodexAppServerCommandPlan>,
  pid?: number | null,
) {
  const state = pid == null ? await readAppServerState(sandbox, plan.statePath) : null;
  const targetPid = pid ?? state?.pid ?? null;
  if (targetPid != null) {
    await sandbox.commands.kill(targetPid).catch(() => false);
  }
  await killSocketAppServerProcesses(sandbox, plan.socketPath);
  await sandbox.commands
    .run(`rm -f ${shellQuote(plan.socketPath)} ${shellQuote(plan.statePath)}`, {
      timeoutMs: CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
    })
    .catch(() => undefined);
}

async function killSocketAppServerProcesses(sandbox: SandboxHandle, socketPath: string) {
  await sandbox.commands
    .run(
      [
        `pkill -f -- ${shellQuote(`app-server.*${socketPath}`)} 2>/dev/null || true`,
        `pkill -f -- ${shellQuote("app-server --listen unix://")} 2>/dev/null || true`,
      ].join("\n"),
      {
        timeoutMs: CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
      },
    )
    .catch(() => undefined);
}

async function runTurnThroughProxy(input: {
  sandbox: SandboxHandle;
  task: string;
  skills?: CodexAppServerSkill[];
  localImages?: CodexAppServerLocalImage[];
  dynamicTools?: CodexAppServerDynamicTool[];
  model: string;
  reasoningEffort: CodexReasoningEffort;
  planModeReasoningEffort: CodexReasoningEffort | null;
  goalMode?: CodexGoalModeInput | null;
  existingEngineSessionId: string | null;
  existingEngineTurnId?: string | null;
  reattachExistingTurn?: boolean;
  forceRestartForRecovery?: boolean;
  timeoutMs: number;
  checkAbort: () => Promise<void>;
  onRuntimeEvents: (events: Record<string, unknown>[]) => Promise<void>;
  onEngineSessionId?: (threadId: string) => Promise<void>;
  onEngineTurnId?: (turnId: string) => Promise<void>;
  onRecoveryStart?: () => Promise<void>;
  onServerRequest?: (request: CodexAppServerRequest) => Promise<Record<string, unknown>>;
  onActivity: (activity: string) => Promise<void>;
  detachOnAbort?: (error: unknown) => boolean;
  plan: ReturnType<typeof buildCodexAppServerCommandPlan>;
}): Promise<CodexAppServerSummary> {
  const accumulator = createCodexAppServerAccumulator({ goalMode: Boolean(input.goalMode) });
  const notificationBatcher = createCodexAppServerNotificationBatcher({
    onFlush: async ({ events, activity }) => {
      if (events.length > 0) await input.onRuntimeEvents(events);
      if (activity) await input.onActivity(activity);
    },
  });
  let threadId: string | null = null;
  let turnId: string | null = null;
  const dynamicTools = validateDynamicTools(input.dynamicTools ?? []);
  const onServerRequest =
    dynamicTools.length > 0 || input.onServerRequest
      ? async (request: CodexAppServerRequest) => {
          if (request.method === "item/tool/call") {
            return executeDynamicToolRequest({
              request,
              tools: dynamicTools,
              expectedThreadId: threadId,
              expectedTurnId: turnId,
            });
          }
          if (!input.onServerRequest) {
            throw new Error(`Unsupported Codex app-server request: ${request.method}`);
          }
          return input.onServerRequest(request);
        }
      : undefined;
  const client = new AppServerProxyClient({
    sandbox: input.sandbox,
    command: input.plan.proxyCommand,
    statePath: input.plan.proxyStatePath,
    envs: input.plan.codexEnv,
    timeoutMs: input.timeoutMs,
    ...(onServerRequest
      ? {
          onServerRequest: async (request: CodexAppServerRequest) => {
            // A request is ordered after every notification already read from the socket. Flush
            // those notifications before surfacing the interaction so the durable UI projection
            // cannot show older streamed parts after the question card.
            await notificationBatcher.flush();
            return onServerRequest(request);
          },
        }
      : {}),
    onNotification: (notification) => {
      const activity = accumulator.push(notification);
      notificationBatcher.push(notification, activity);
    },
  });

  try {
    await client.start();
    await client.request("initialize", {
      clientInfo: {
        name: CODEX_APP_SERVER_CLIENT_NAME,
        title: "OpenCompany Runner",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    await client.notify("initialized", {});

    const thread = await startOrResumeThread({
      client,
      input: { ...input, dynamicTools },
    });
    threadId = thread.id;
    if (threadId !== input.existingEngineSessionId) {
      await input.onEngineSessionId?.(threadId);
    }
    if (input.goalMode) {
      const goal = input.reattachExistingTurn
        ? await getThreadGoal({ client, threadId })
        : await setThreadGoal({ client, threadId, goalMode: input.goalMode });
      accumulator.setGoal(goal);
    }
    const existingTurn = input.reattachExistingTurn
      ? findThreadTurn(thread.value, input.existingEngineTurnId ?? null)
      : null;
    if (existingTurn && !isInterruptedTurn(existingTurn)) {
      turnId = firstString(existingTurn.id);
      if (!turnId) throw new Error("Codex app-server returned a turn without an id.");
      if (turnId !== input.existingEngineTurnId) await input.onEngineTurnId?.(turnId);
      replayThreadTurn({
        threadId,
        turn: existingTurn,
        onNotification: (notification) => {
          const activity = accumulator.push(notification);
          notificationBatcher.push(notification, activity);
        },
      });
      logger.info("Reattached to Codex app-server turn", {
        event: "opencompany.codex_app_server_turn_reattached",
        thread_id: threadId,
        turn_id: turnId,
        turn_status: firstString(existingTurn.status),
      });
    } else {
      if (input.reattachExistingTurn) await input.onRecoveryStart?.();
      const turn = await client.request("turn/start", {
        threadId,
        input: [
          { type: "text", text: input.task, text_elements: [] },
          ...(input.skills ?? []).map((skill) => ({
            type: "skill",
            name: skill.name,
            path: skill.path,
          })),
          ...(input.localImages ?? []).map((image) => ({
            type: "localImage",
            path: image.path,
            ...(image.detail ? { detail: image.detail } : {}),
          })),
        ],
        cwd: input.plan.codexWorkRoot,
        model: input.model,
        effort: input.reasoningEffort,
        collaborationMode: codexCollaborationMode({
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          planModeReasoningEffort: input.planModeReasoningEffort,
        }),
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [input.plan.codexWorkRoot],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      });
      turnId = stringFromPath(turn, ["turn", "id"]);
      if (!turnId) throw new Error("Codex app-server did not return a turn id.");
      await input.onEngineTurnId?.(turnId);
    }
    const completion = await waitForTurnCompletion({
      promise: accumulator.completed,
      checkAbort: async () => {
        client.throwIfFailed();
        await input.checkAbort();
      },
      timeoutMs: input.timeoutMs,
      interrupt: () =>
        turnId
          ? client.request("turn/interrupt", { threadId, turnId }).then(
              () => undefined,
              () => undefined,
            )
          : Promise.resolve(),
      ...(input.detachOnAbort ? { detachOnAbort: input.detachOnAbort } : {}),
    });
    await notificationBatcher.flush();
    const summary = accumulator.summary();
    if (completion === "timeout") {
      return {
        ...summary,
        status: "timeout",
        error: "Codex timed out before finishing. The partial output is shown below.",
      };
    }
    return summary;
  } finally {
    await notificationBatcher.settleIgnoringError();
    await client.stop();
  }
}

async function setThreadGoal(input: {
  client: AppServerProxyClient;
  threadId: string;
  goalMode: CodexGoalModeInput;
}) {
  const params = {
    threadId: input.threadId,
    objective: input.goalMode.objective,
    status: "active",
    ...(input.goalMode.tokenBudget != null ? { tokenBudget: input.goalMode.tokenBudget } : {}),
  };
  const response = await input.client.request("thread/goal/set", params);
  return goalFromValue(response) ?? goalFromValue(params);
}

async function getThreadGoal(input: { client: AppServerProxyClient; threadId: string }) {
  const response = await input.client.request("thread/goal/get", { threadId: input.threadId });
  return goalFromValue(response);
}

async function startOrResumeThread(input: {
  client: AppServerProxyClient;
  input: {
    existingEngineSessionId: string | null;
    model: string;
    reasoningEffort: CodexReasoningEffort;
    planModeReasoningEffort: CodexReasoningEffort | null;
    dynamicTools: CodexAppServerDynamicTool[];
    plan: ReturnType<typeof buildCodexAppServerCommandPlan>;
  };
}) {
  if (input.input.existingEngineSessionId) {
    const resumed = await input.client.request("thread/resume", {
      threadId: input.input.existingEngineSessionId,
      model: input.input.model,
      cwd: input.input.plan.codexWorkRoot,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      config: reasoningConfig(input.input.reasoningEffort, input.input.planModeReasoningEffort),
    });
    return {
      id: stringFromPath(resumed, ["thread", "id"]) ?? input.input.existingEngineSessionId,
      value: isRecord(resumed) && isRecord(resumed.thread) ? resumed.thread : {},
    };
  }

  const started = await input.client.request("thread/start", {
    model: input.input.model,
    cwd: input.input.plan.codexWorkRoot,
    sandbox: "workspace-write",
    approvalPolicy: "never",
    config: reasoningConfig(input.input.reasoningEffort, input.input.planModeReasoningEffort),
    ...(input.input.dynamicTools.length > 0
      ? { dynamicTools: input.input.dynamicTools.map((tool) => tool.spec) }
      : {}),
  });
  const threadId = stringFromPath(started, ["thread", "id"]);
  if (!threadId) throw new Error("Codex app-server did not return a thread id.");
  return {
    id: threadId,
    value: isRecord(started) && isRecord(started.thread) ? started.thread : {},
  };
}

function validateDynamicTools(
  tools: readonly CodexAppServerDynamicTool[],
): CodexAppServerDynamicTool[] {
  const names = new Set<string>();
  for (const tool of tools) {
    const name = tool.spec.name.trim();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) {
      throw new Error(`Invalid Codex dynamic tool name: ${JSON.stringify(tool.spec.name)}.`);
    }
    if (names.has(name)) throw new Error(`Duplicate Codex dynamic tool: ${name}.`);
    names.add(name);
  }
  return [...tools];
}

async function executeDynamicToolRequest(input: {
  request: CodexAppServerRequest;
  tools: readonly CodexAppServerDynamicTool[];
  expectedThreadId: string | null;
  expectedTurnId: string | null;
}): Promise<Record<string, unknown>> {
  const threadId = firstString(input.request.params.threadId);
  const turnId = firstString(input.request.params.turnId);
  const callId = firstString(input.request.params.callId);
  const toolName = firstString(input.request.params.tool);
  const hasNamespace =
    input.request.params.namespace !== null && input.request.params.namespace !== undefined;
  if (!threadId || !turnId || !callId || !toolName || hasNamespace) {
    throw new Error("Codex sent an invalid dynamic tool request.");
  }
  if (input.expectedThreadId && threadId !== input.expectedThreadId) {
    throw new Error("Codex dynamic tool request did not match the active thread.");
  }
  if (input.expectedTurnId && turnId !== input.expectedTurnId) {
    throw new Error("Codex dynamic tool request did not match the active turn.");
  }

  const tool = input.tools.find((candidate) => candidate.spec.name === toolName);
  if (!tool) throw new Error(`Unsupported Codex dynamic tool: ${toolName}.`);

  try {
    const response = await tool.execute({
      threadId,
      turnId,
      callId,
      namespace: null,
      tool: toolName,
      arguments: input.request.params.arguments,
    });
    return {
      success: response.success,
      contentItems: response.contentItems,
    };
  } catch (error) {
    return {
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: error instanceof Error ? error.message : "The host tool failed.",
        },
      ],
    };
  }
}

function findThreadTurn(thread: Record<string, unknown>, turnId: string | null) {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  let activeTurn: Record<string, unknown> | null = null;
  for (const value of turns) {
    if (!isRecord(value)) continue;
    if (turnId && firstString(value.id) === turnId) return value;
    if (!isTerminalTurn(value)) activeTurn = value;
  }
  return activeTurn;
}

function isInterruptedTurn(turn: Record<string, unknown>) {
  return firstString(turn.status) === "interrupted";
}

function replayThreadTurn(input: {
  threadId: string;
  turn: Record<string, unknown>;
  onNotification: (notification: JsonRpcNotification) => void;
}) {
  const turnId = firstString(input.turn.id);
  if (!turnId) throw new Error("Codex app-server returned a turn without an id.");
  input.onNotification({
    method: "turn/started",
    params: { threadId: input.threadId, turn: input.turn },
  });
  for (const value of Array.isArray(input.turn.items) ? input.turn.items : []) {
    if (!isRecord(value)) continue;
    input.onNotification({
      method: "item/started",
      params: { threadId: input.threadId, turnId, item: value },
    });
    if (!isActiveItem(value)) {
      input.onNotification({
        method: "item/completed",
        params: { threadId: input.threadId, turnId, item: value },
      });
    }
  }
  if (isTerminalTurn(input.turn)) {
    input.onNotification({
      method: "turn/completed",
      params: { threadId: input.threadId, turn: input.turn },
    });
  }
}

function isActiveItem(item: Record<string, unknown>) {
  const status = firstString(item.status)?.toLowerCase();
  return status === "inprogress" || status === "running" || status === "pending";
}

function isTerminalTurn(turn: Record<string, unknown>) {
  const status = firstString(turn.status)?.toLowerCase();
  return status === "completed" || status === "failed" || status === "interrupted";
}

function createCodexAppServerNotificationBatcher(input: {
  onFlush: (batch: { events: Record<string, unknown>[]; activity: string | null }) => Promise<void>;
}) {
  let events: JsonRpcNotification[] = [];
  let activities: string[] = [];
  let pendingDeltaChars = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushChain = Promise.resolve();
  let flushError: unknown = null;

  const flushCurrent = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (events.length === 0 && activities.length === 0) return flushChain;

    const batchEvents = coalesceCodexAppServerNotifications(events);
    const batchActivity = activities.length > 0 ? activities.join("") : null;
    events = [];
    activities = [];
    pendingDeltaChars = 0;

    flushChain = flushChain.then(async () => {
      try {
        await input.onFlush({ events: batchEvents, activity: batchActivity });
      } catch (error) {
        flushError ??= error;
      }
    });
    return flushChain;
  };

  return {
    push(notification: JsonRpcNotification, activity: string | null) {
      events.push(notification);
      if (activity != null && activity.length > 0) activities.push(activity);

      const delta = coalescibleDelta(notification);
      if (!delta) {
        void flushCurrent();
        return;
      }

      pendingDeltaChars += delta.delta.length;
      if (pendingDeltaChars >= CODEX_APP_SERVER_NOTIFICATION_FLUSH_CHARS) {
        void flushCurrent();
        return;
      }

      if (!timer) {
        timer = setTimeout(() => {
          void flushCurrent();
        }, CODEX_APP_SERVER_NOTIFICATION_FLUSH_MS);
      }
    },
    async flush() {
      await flushCurrent();
      if (flushError) throw flushError;
    },
    async settleIgnoringError() {
      await flushCurrent().catch(() => undefined);
    },
  };
}

export function coalesceCodexAppServerNotifications(
  notifications: JsonRpcNotification[],
): Record<string, unknown>[] {
  const output: JsonRpcNotification[] = [];
  let pending: JsonRpcNotification | null = null;
  let pendingKey: string | null = null;

  const flushPending = () => {
    if (pending) output.push(pending);
    pending = null;
    pendingKey = null;
  };

  for (const notification of notifications) {
    const delta = coalescibleDelta(notification);
    if (!delta) {
      flushPending();
      output.push(notification);
      continue;
    }

    if (pending && pendingKey === delta.key) {
      const pendingNotification: JsonRpcNotification = pending;
      const params: Record<string, unknown> = isRecord(pendingNotification.params)
        ? pendingNotification.params
        : {};
      pending = {
        ...pendingNotification,
        params: {
          ...params,
          delta: `${rawString(params.delta) ?? ""}${delta.delta}`,
        },
      };
      continue;
    }

    flushPending();
    pending = {
      ...notification,
      params: {
        ...(notification.params ?? {}),
        delta: delta.delta,
      },
    };
    pendingKey = delta.key;
  }

  flushPending();
  return output;
}

function coalescibleDelta(notification: JsonRpcNotification) {
  const params = notification.params;
  const delta = rawString(params?.delta);
  if (delta == null || !COALESCIBLE_DELTA_METHODS.has(notification.method)) return null;

  return {
    delta,
    key: JSON.stringify([
      notification.method,
      firstString(params?.threadId),
      firstString(params?.turnId),
      firstString(params?.itemId),
      firstString(params?.stream),
      firstString(params?.command),
    ]),
  };
}

const COALESCIBLE_DELTA_METHODS = new Set([
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
]);

function reasoningConfig(
  reasoningEffort: CodexReasoningEffort,
  planModeReasoningEffort: CodexReasoningEffort | null,
) {
  return {
    model_reasoning_effort: reasoningEffort,
    ...(planModeReasoningEffort ? { plan_mode_reasoning_effort: planModeReasoningEffort } : {}),
  };
}

export function codexCollaborationMode(input: {
  model: string;
  reasoningEffort: CodexReasoningEffort;
  planModeReasoningEffort: CodexReasoningEffort | null;
}) {
  return {
    mode: input.planModeReasoningEffort ? "plan" : "default",
    settings: {
      model: input.model,
      reasoning_effort: input.planModeReasoningEffort ?? input.reasoningEffort,
      developer_instructions: null,
    },
  };
}

class AppServerProxyClient {
  private buffer = "";
  private nextId = 1;
  private handle: unknown = null;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private lastStderr: string | null = null;
  private failure: Error | null = null;

  constructor(
    private readonly input: {
      sandbox: SandboxHandle;
      command: string;
      statePath: string;
      envs: Record<string, string>;
      timeoutMs: number;
      onServerRequest?: (request: CodexAppServerRequest) => Promise<Record<string, unknown>>;
      onNotification: (notification: JsonRpcNotification) => void;
    },
  ) {}

  async start() {
    logger.info("Starting Codex app-server proxy", {
      event: "opencompany.codex_app_server_proxy_starting",
    });
    await stopOrphanedAppServerProxy(this.input.sandbox, this.input.statePath);
    this.handle = await this.input.sandbox.commands.run(this.input.command, {
      background: true,
      stdin: true,
      envs: this.input.envs,
      timeoutMs: this.input.timeoutMs,
      onStdout: (data: string) => {
        void this.onStdout(data).catch((error) => this.fail(error));
      },
      onStderr: async (data: string) => {
        if (data.trim()) this.lastStderr = truncateText(data.trim(), 500);
      },
    });
    logger.info("Started Codex app-server proxy", {
      event: "opencompany.codex_app_server_proxy_started",
      pid: commandHandlePid(this.handle),
    });
    const pid = commandHandlePid(this.handle);
    if (pid != null) {
      await this.input.sandbox.files.write(this.input.statePath, JSON.stringify({ pid }));
    }
  }

  async stop() {
    const pid = commandHandlePid(this.handle);
    if (pid != null) await this.input.sandbox.commands.kill(pid).catch(() => false);
    await clearAppServerProxyState(this.input.sandbox, this.input.statePath, pid);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex app-server proxy stopped before responding."));
    }
    this.pending.clear();
  }

  request(method: string, params: unknown) {
    const id = this.nextId++;
    logger.info("Sending Codex app-server request", {
      event: "opencompany.codex_app_server_request_started",
      method,
      request_id: id,
    });
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const suffix = this.lastStderr ? ` Last stderr: ${this.lastStderr}` : "";
        logger.warn("Codex app-server request timed out", {
          event: "opencompany.codex_app_server_request_timeout",
          method,
          request_id: id,
          has_stderr: Boolean(this.lastStderr),
        });
        reject(new Error(`Codex app-server request "${method}" timed out.${suffix}`));
      }, CODEX_APP_SERVER_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
    });
    void this.send({ method, id, params }).catch((error) => {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      this.pending.delete(id);
    });
    return response;
  }

  async notify(method: string, params: unknown) {
    await this.send({ method, params });
  }

  throwIfFailed() {
    if (this.failure) throw this.failure;
  }

  private async send(message: unknown) {
    this.throwIfFailed();
    const pid = commandHandlePid(this.handle);
    if (pid == null) throw new Error("Codex app-server proxy is not running.");
    const data = `${JSON.stringify(message)}\n`;
    const handle = this.handle as { sendStdin?: (data: string) => Promise<void> };
    if (typeof handle.sendStdin === "function") {
      await handle.sendStdin(data);
      return;
    }
    await this.input.sandbox.commands.sendStdin(pid, data);
  }

  private async onStdout(data: string) {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      await this.consumeLine(line);
    }
  }

  private async consumeLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (
      (typeof message.id === "number" || typeof message.id === "string") &&
      typeof message.method === "string"
    ) {
      void this.handleServerRequest({
        id: message.id,
        method: message.method,
        params: isRecord(message.params) ? message.params : {},
      });
      return;
    }
    if (typeof message.id === "number") {
      this.resolveResponse(message as JsonRpcResponse);
      return;
    }
    if (typeof message.method === "string") {
      this.input.onNotification(message as JsonRpcNotification);
    }
  }

  private async handleServerRequest(request: CodexAppServerRequest) {
    try {
      if (!this.input.onServerRequest) {
        throw new Error(`Codex app-server request "${request.method}" is not supported here.`);
      }
      const result = await this.input.onServerRequest(request);
      await this.send({ id: request.id, result });
    } catch (error) {
      await this.send({
        id: request.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Codex client request failed.",
        },
      }).catch(() => undefined);
    }
  }

  private resolveResponse(response: JsonRpcResponse) {
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timeout);
    if (response.error) {
      logger.warn("Codex app-server request failed", {
        event: "opencompany.codex_app_server_request_failed",
        request_id: response.id,
        code: response.error.code,
        message: response.error.message,
      });
      pending.reject(
        new CodexAppServerRpcError(response.error.message ?? "Codex app-server error"),
      );
      return;
    }
    logger.info("Codex app-server request completed", {
      event: "opencompany.codex_app_server_request_completed",
      request_id: response.id,
    });
    pending.resolve(response.result ?? {});
  }

  private fail(error: unknown) {
    this.failure = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(this.failure);
    }
    this.pending.clear();
  }
}

class CodexAppServerRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAppServerRpcError";
  }
}

export function createCodexAppServerAccumulator(input: { goalMode?: boolean } = {}) {
  let sessionId: string | null = null;
  let latestAgentMessageText = "";
  const agentMessageTextByItemId = new Map<string, string>();
  let finalAgentText = "";
  let error: string | null = null;
  let usage: CodexUsage | null = null;
  let goal: CodexAppServerGoalSummary | null = null;
  let completedResolve: (() => void) | null = null;
  const completed = new Promise<void>((resolve) => {
    completedResolve = resolve;
  });
  let status: CodexAppServerSummary["status"] = "unknown";
  const resolveCompleted = () => {
    completedResolve?.();
    completedResolve = null;
  };

  return {
    completed,
    setGoal(nextGoal: CodexAppServerGoalSummary | null) {
      goal = mergeGoal(goal, nextGoal);
    },
    push(notification: JsonRpcNotification) {
      const params = notification.params;
      const foundThreadId = firstString(params?.threadId, stringFromPath(params, ["thread", "id"]));
      if (foundThreadId && !sessionId) sessionId = foundThreadId;

      if (notification.method === "item/agentMessage/delta") {
        const delta = rawString(params?.delta);
        if (delta) {
          const itemId = firstString(params?.itemId) ?? "__default_agent_message";
          const next = `${agentMessageTextByItemId.get(itemId) ?? ""}${delta}`;
          agentMessageTextByItemId.set(itemId, next);
          latestAgentMessageText = next;
        }
        return null;
      }

      if (notification.method === "item/completed") {
        const item = isRecord(params?.item) ? params.item : null;
        if (item?.type === "agentMessage") {
          finalAgentText = firstString(item.text) ?? finalAgentText;
          return compactActivity(finalAgentText || "Codex message completed");
        }
        if (isReasoningItem(item)) {
          const text = firstString(item?.text, item?.summary, item?.content);
          return compactActivity(
            text ? `Codex reasoning completed: ${text}` : "Codex reasoning completed",
          );
        }
        if (item?.type === "commandExecution") {
          return compactActivity(
            `Codex command completed: ${firstString(item.command) ?? "command completed"}`,
          );
        }
      }

      if (notification.method === "item/started") {
        return null;
      }

      if (notification.method === "thread/tokenUsage/updated") {
        usage = usageFromNotification(params);
      }

      if (notification.method === "thread/goal/updated") {
        goal = mergeGoal(goal, goalFromValue(params));
        const goalStatus = goal?.status ?? null;
        if (goalStatus && isTerminalGoalStatus(goalStatus)) {
          status = "success";
          resolveCompleted();
        }
        return goalStatus ? compactActivity(`Codex goal: ${formatGoalStatus(goalStatus)}`) : null;
      }

      if (notification.method === "thread/goal/cleared") {
        goal = mergeGoal(goal, { status: "cleared" });
        status = "success";
        if (input.goalMode) resolveCompleted();
        return compactActivity("Codex goal: cleared");
      }

      if (notification.method === "turn/completed") {
        const turn = isRecord(params?.turn) ? params.turn : null;
        const turnStatus = firstString(turn?.status);
        status =
          turnStatus === "completed"
            ? "success"
            : turnStatus === "failed" || turnStatus === "interrupted"
              ? "error"
              : "unknown";
        error =
          turnStatus === "interrupted"
            ? "Codex was interrupted before finishing."
            : (firstString(stringFromPath(turn, ["error", "message"])) ?? error);
        if (
          status === "error" ||
          !input.goalMode ||
          (goal?.status && isTerminalGoalStatus(goal.status))
        ) {
          resolveCompleted();
        }
        return status === "success" ? "Codex completed" : null;
      }

      if (notification.method === "error") {
        error = firstString(params?.message) ?? error;
      }

      return null;
    },
    summary(): CodexAppServerSummary {
      const result = (finalAgentText || latestAgentMessageText).trim();
      return {
        sessionId,
        status: error && status === "unknown" ? "error" : status,
        result,
        error,
        usage,
        goal,
      };
    },
  };
}

async function waitForTurnCompletion(input: {
  promise: Promise<void>;
  checkAbort: () => Promise<void>;
  timeoutMs: number;
  interrupt: () => Promise<void>;
  detachOnAbort?: (error: unknown) => boolean;
}) {
  const deadline = Date.now() + input.timeoutMs;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      await input.interrupt();
      return "timeout" as const;
    }
    const completed = await Promise.race([
      input.promise.then(() => true),
      sleep(Math.min(1_000, remainingMs)).then(() => false),
    ]);
    if (completed) return "completed" as const;
    try {
      await input.checkAbort();
    } catch (error) {
      if (!input.detachOnAbort?.(error)) await input.interrupt();
      throw error;
    }
  }
}

async function appServerProcessReady(sandbox: SandboxHandle, state: AppServerState) {
  const result = await sandbox.commands
    .run(`kill -0 ${state.pid} && test -S ${shellQuote(state.socketPath)}`, {
      timeoutMs: CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
    })
    .catch(() => null);
  return Boolean(result);
}

async function waitForEndpoint(sandbox: SandboxHandle, endpoint: string) {
  await sandbox.commands.run(
    `for i in $(seq 1 100); do test -S ${shellQuote(endpoint)} && exit 0; sleep 0.1; done; exit 1`,
    { timeoutMs: CODEX_APP_SERVER_REQUEST_TIMEOUT_MS },
  );
}

export function codexAppServerProxyScript() {
  // Codex documents the Unix-socket transport as its supported local control plane. This small
  // adapter keeps the runner-facing stream JSONL while speaking the required WebSocket framing
  // over the Unix socket inside E2B.
  return `import { createHash, randomBytes } from "node:crypto";
import { createConnection } from "node:net";

const socketPath = process.argv[2];
if (!socketPath) {
  console.error("missing app-server socket path");
  process.exit(1);
}

const socket = createConnection({ path: socketPath });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timed out connecting to app-server")), 30_000);
  socket.once("connect", () => {
    clearTimeout(timer);
    resolve(undefined);
  });
  socket.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
});

const key = randomBytes(16).toString("base64");
const expectedAccept = createHash("sha1")
  .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
  .digest("base64");
socket.write([
  "GET / HTTP/1.1",
  "Host: localhost",
  "Upgrade: websocket",
  "Connection: Upgrade",
  "Sec-WebSocket-Key: " + key,
  "Sec-WebSocket-Version: 13",
  "",
  "",
].join("\\r\\n"));

let upgraded = false;
let incoming = Buffer.alloc(0);
let fragmentedOpcode = null;
let fragments = [];
let resolveUpgrade;
let rejectUpgrade;
const upgrade = new Promise((resolve, reject) => {
  resolveUpgrade = resolve;
  rejectUpgrade = reject;
});

socket.on("data", (chunk) => {
  try {
    incoming = Buffer.concat([incoming, chunk]);
    if (!upgraded) {
      const boundary = incoming.indexOf("\\r\\n\\r\\n");
      if (boundary < 0) return;
      const headers = incoming.subarray(0, boundary).toString("utf8");
      if (!/^HTTP\\/1\\.1 101 /i.test(headers)) throw new Error("app-server upgrade failed");
      const accept = headers.match(/^Sec-WebSocket-Accept:\\s*(.+)$/im)?.[1]?.trim();
      if (accept !== expectedAccept) throw new Error("app-server upgrade response was invalid");
      incoming = incoming.subarray(boundary + 4);
      upgraded = true;
      resolveUpgrade();
    }
    consumeFrames();
  } catch (error) {
    rejectUpgrade(error);
    socket.destroy(error);
  }
});
socket.on("error", (error) => {
  rejectUpgrade(error);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
socket.on("close", () => process.exit(0));

function consumeFrames() {
  while (incoming.length >= 2) {
    const first = incoming[0];
    const second = incoming[1];
    const final = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (incoming.length < 4) return;
      length = incoming.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (incoming.length < 10) return;
      const wideLength = incoming.readBigUInt64BE(2);
      if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("app-server frame too large");
      length = Number(wideLength);
      offset = 10;
    }
    const maskLength = masked ? 4 : 0;
    if (incoming.length < offset + maskLength + length) return;
    const mask = masked ? incoming.subarray(offset, offset + 4) : null;
    offset += maskLength;
    const payload = Buffer.from(incoming.subarray(offset, offset + length));
    incoming = incoming.subarray(offset + length);
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    if (opcode === 0x8) {
      socket.end();
      return;
    }
    if (opcode === 0x9) {
      sendFrame(payload, 0x0a);
      continue;
    }
    if (opcode === 0x0a) continue;
    if (opcode === 0x1 || opcode === 0x2) {
      fragmentedOpcode = opcode;
      fragments = [payload];
    } else if (opcode === 0x0 && fragmentedOpcode != null) {
      fragments.push(payload);
    } else {
      continue;
    }
    if (!final) continue;
    if (fragmentedOpcode === 0x1) process.stdout.write(Buffer.concat(fragments).toString("utf8") + "\\n");
    fragmentedOpcode = null;
    fragments = [];
  }
}

function sendFrame(value, opcode = 0x1) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const mask = randomBytes(4);
  let header;
  if (payload.length <= 125) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length <= 65_535) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
  socket.write(Buffer.concat([header, mask, masked]));
}

await upgrade;
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) sendFrame(trimmed);
  }
}
const trailing = buffer.trim();
if (trailing) sendFrame(trailing);
sendFrame(Buffer.alloc(0), 0x08);
socket.end();
`;
}

async function stopOrphanedAppServerProxy(sandbox: SandboxHandle, statePath: string) {
  const pid = await readAppServerProxyPid(sandbox, statePath);
  if (pid != null) await sandbox.commands.kill(pid).catch(() => false);
  await sandbox.commands
    .run(`rm -f ${shellQuote(statePath)}`, { timeoutMs: CODEX_APP_SERVER_REQUEST_TIMEOUT_MS })
    .catch(() => undefined);
}

async function clearAppServerProxyState(
  sandbox: SandboxHandle,
  statePath: string,
  expectedPid: number | null,
) {
  if (expectedPid == null) return;
  const storedPid = await readAppServerProxyPid(sandbox, statePath);
  if (storedPid !== expectedPid) return;
  await sandbox.commands
    .run(`rm -f ${shellQuote(statePath)}`, { timeoutMs: CODEX_APP_SERVER_REQUEST_TIMEOUT_MS })
    .catch(() => undefined);
}

async function readAppServerProxyPid(sandbox: SandboxHandle, statePath: string) {
  try {
    const content = await sandbox.files.read(statePath);
    const parsed = JSON.parse(
      typeof content === "string" ? content : new TextDecoder().decode(content),
    );
    return isRecord(parsed) && typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

async function readAppServerState(sandbox: SandboxHandle, path: string) {
  try {
    const content = await sandbox.files.read(path);
    const parsed = JSON.parse(
      typeof content === "string" ? content : new TextDecoder().decode(content),
    );
    if (!isRecord(parsed)) return null;
    const pid = typeof parsed.pid === "number" ? parsed.pid : null;
    const socketPath = typeof parsed.socketPath === "string" ? parsed.socketPath : null;
    const fingerprint = typeof parsed.fingerprint === "string" ? parsed.fingerprint : null;
    return pid != null && socketPath && fingerprint ? { pid, socketPath, fingerprint } : null;
  } catch {
    return null;
  }
}

function appServerFingerprint(input: {
  config: string;
  skillFingerprint: string;
  auth: CodexCliAuth;
  githubAuth: CodexGitHubAuth;
}) {
  return hashJson({
    config: input.config,
    skillFingerprint: input.skillFingerprint,
    auth:
      input.auth.kind === "api"
        ? {
            kind: "api",
            baseUrl: input.auth.baseUrl,
            apiKeyEnvVar: input.auth.apiKeyEnvVar,
            apiKeyHash: hash(input.auth.apiKeyValue),
            brokered: input.auth.brokered,
          }
        : {
            kind: "chatgpt",
            authHash: hashJson(input.auth.authJson),
          },
    githubTokenHash: input.githubAuth.githubToken ? hash(input.githubAuth.githubToken) : null,
    githubAuthHeaderHash: input.githubAuth.githubAuthHeader
      ? hash(input.githubAuth.githubAuthHeader)
      : null,
  });
}

function usageFromNotification(params: Record<string, unknown> | undefined): CodexUsage | null {
  const last =
    isRecord(params?.tokenUsage) && isRecord(params.tokenUsage.last)
      ? params.tokenUsage.last
      : null;
  if (!last) return null;
  const inputTokens = numberFrom(last.inputTokens);
  const outputTokens = numberFrom(last.outputTokens);
  if (inputTokens == null || outputTokens == null) return null;
  const cachedInputTokens = numberFrom(last.cachedInputTokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cachedInputTokens ? { cache_read_input_tokens: cachedInputTokens } : {}),
  };
}

function goalFromValue(value: unknown): CodexAppServerGoalSummary | null {
  const record = isRecord(value) ? value : null;
  if (!record) return null;
  const goalRecord = isRecord(record.goal) ? record.goal : record;
  const objective = firstString(goalRecord.objective) ?? null;
  const status = goalStatusFromValue(goalRecord.status);
  const tokenBudget = numberFrom(goalRecord.tokenBudget);
  const tokensUsed = numberFrom(goalRecord.tokensUsed);
  const timeUsedSeconds = numberFrom(goalRecord.timeUsedSeconds);
  if (
    !objective &&
    !status &&
    tokenBudget == null &&
    tokensUsed == null &&
    timeUsedSeconds == null
  ) {
    return null;
  }
  return {
    objective,
    status,
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
  };
}

function mergeGoal(
  current: CodexAppServerGoalSummary | null,
  next: Partial<CodexAppServerGoalSummary> | null,
): CodexAppServerGoalSummary | null {
  if (!next) return current;
  return {
    objective: next.objective ?? current?.objective ?? null,
    status: next.status ?? current?.status ?? null,
    tokenBudget: next.tokenBudget ?? current?.tokenBudget ?? null,
    tokensUsed: next.tokensUsed ?? current?.tokensUsed ?? null,
    timeUsedSeconds: next.timeUsedSeconds ?? current?.timeUsedSeconds ?? null,
  };
}

function goalStatusFromValue(value: unknown): CodexGoalStatus | null {
  return value === "active" ||
    value === "paused" ||
    value === "complete" ||
    value === "blocked" ||
    value === "budgetLimited" ||
    value === "usageLimited" ||
    value === "cleared"
    ? value
    : null;
}

function isTerminalGoalStatus(status: CodexGoalStatus) {
  return (
    status === "complete" ||
    status === "blocked" ||
    status === "budgetLimited" ||
    status === "usageLimited" ||
    status === "cleared"
  );
}

function formatGoalStatus(status: CodexGoalStatus) {
  if (status === "budgetLimited") return "budget-limited";
  if (status === "usageLimited") return "usage-limited";
  return status;
}

function isInitializeFailure(error: unknown) {
  return (
    error instanceof CodexAppServerRpcError || /app-server|proxy|initialize/i.test(String(error))
  );
}

function commandHandlePid(handle: unknown) {
  return isRecord(handle) && typeof handle.pid === "number" ? handle.pid : null;
}

function stringFromPath(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return firstString(current);
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function rawString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberFrom(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compactActivity(value: string) {
  const text = truncateText(value.replace(/\s+/g, " ").trim(), 500);
  return text ? `\n\n${text}\n` : "";
}

function isReasoningItem(item: Record<string, unknown> | null) {
  return typeof item?.type === "string" && item.type.toLowerCase().includes("reasoning");
}

function hashJson(value: unknown) {
  return hash(JSON.stringify(value));
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
