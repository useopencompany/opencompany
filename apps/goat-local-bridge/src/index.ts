import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import {
  buildCodexAppServerArgs,
  CODEX_APP_SERVER_ACCESS_MODE,
  CODEX_APP_SERVER_ENV_INHERIT,
} from "./codex-app-server";
import { ensureDetachedHeadWorktree, ensureEmptySessionWorkspace } from "./worktree";

const LOCAL_CODEX_DEFAULT_MODEL = "gpt-5.5";

type BridgeOptions = {
  baseUrl: string;
  token: string;
  model: string;
  name: string;
};

type BridgeCommandKind = "start_turn" | "steer" | "interrupt" | "close";

type BridgeCommand = {
  id: string;
  kind: BridgeCommandKind;
  localCodexSessionId: string;
  localCodexTurnId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

type CodexSessionRuntime = {
  appServer: CodexAppServerClient;
  threadId: string;
  worktreePath: string;
  activeTurnId: string | null;
  eventContext: {
    localCodexTurnId: string | null;
    commandId: string | null;
  };
  eventBatcher: CodexEventBatcher;
};

const sessions = new Map<string, CodexSessionRuntime>();
let shuttingDown = false;

installSignalHandlers();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await postJson(options, "/api/local-codex/bridge/heartbeat", { name: options.name });
  console.log(`[goat-local-bridge] connected to ${options.baseUrl}`);

  while (true) {
    try {
      const response = await postJson<{ commands: BridgeCommand[] }>(
        options,
        "/api/local-codex/bridge/commands",
        { limit: 5, name: options.name },
      );
      for (const command of response.commands) {
        await handleCommand(options, command);
      }
    } catch (error) {
      console.error("[goat-local-bridge] poll failed:", errorMessage(error));
      await sleep(2_000);
    }
  }
}

async function handleCommand(options: BridgeOptions, command: BridgeCommand) {
  console.log(
    `[goat-local-bridge] handling ${command.kind} command ${command.id} for ${command.localCodexSessionId}`,
  );
  try {
    if (command.kind === "start_turn") {
      const result = await startTurn(options, command);
      await acknowledgeCommand(options, command, {
        status: "succeeded",
        codexThreadId: result.threadId,
        codexTurnId: result.turnId,
        worktreePath: result.worktreePath,
      });
      console.log(
        `[goat-local-bridge] started turn for ${command.localCodexSessionId} in ${result.worktreePath}`,
      );
      return;
    }

    const runtime = sessions.get(command.localCodexSessionId);
    if (!runtime) {
      if (command.kind === "interrupt" || command.kind === "close") {
        await acknowledgeCommand(options, command, { status: "succeeded" });
        console.log(
          `[goat-local-bridge] completed ${command.kind} command ${command.id}; runtime was already inactive`,
        );
        return;
      }
      throw new Error("Local Codex runtime is not active for this session.");
    }

    if (command.kind === "steer") {
      const prompt = readString(command.payload.prompt);
      if (!prompt) throw new Error("Steer command is missing a prompt.");
      await runtime.appServer.request("turn/steer", {
        threadId: runtime.threadId,
        ...(runtime.activeTurnId ? { turnId: runtime.activeTurnId } : {}),
        input: textInput(prompt),
      });
    } else if (command.kind === "interrupt") {
      await runtime.appServer.request("turn/interrupt", {
        threadId: runtime.threadId,
        ...(runtime.activeTurnId ? { turnId: runtime.activeTurnId } : {}),
      });
    } else if (command.kind === "close") {
      runtime.appServer.close();
      sessions.delete(command.localCodexSessionId);
    }

    await acknowledgeCommand(options, command, { status: "succeeded" });
    console.log(`[goat-local-bridge] completed ${command.kind} command ${command.id}`);
  } catch (error) {
    console.error(`[goat-local-bridge] command ${command.id} failed: ${errorMessage(error)}`);
    await acknowledgeCommand(options, command, {
      status: "failed",
      error: errorMessage(error),
    });
  }
}

async function startTurn(options: BridgeOptions, command: BridgeCommand) {
  const prompt = readString(command.payload.prompt);
  const repositoryPath = readString(command.payload.repositoryPath);
  if (!prompt) throw new Error("Start command is missing a prompt.");

  const existing = sessions.get(command.localCodexSessionId);
  const worktreePath = readString(command.payload.worktreePath);
  const runtime =
    existing ??
    (await createSessionRuntime(options, {
      localCodexSessionId: command.localCodexSessionId,
      localCodexTurnId: command.localCodexTurnId,
      commandId: command.id,
      repositoryPath,
      worktreePath,
      codexThreadId: readString(command.payload.codexThreadId),
      model: readString(command.payload.model) || options.model,
    }));

  runtime.eventContext.localCodexTurnId = command.localCodexTurnId;
  runtime.eventContext.commandId = command.id;

  const turnResult = await runtime.appServer.request("turn/start", {
    threadId: runtime.threadId,
    input: textInput(prompt),
    cwd: runtime.worktreePath,
    model: readString(command.payload.model) || options.model,
  });
  const turnId = readStringPath(turnResult, ["turn", "id"]) ?? readStringPath(turnResult, ["id"]);
  runtime.activeTurnId = turnId;

  return {
    threadId: runtime.threadId,
    turnId,
    worktreePath: runtime.worktreePath,
  };
}

async function createSessionRuntime(
  options: BridgeOptions,
  input: {
    localCodexSessionId: string;
    localCodexTurnId: string | null;
    commandId: string;
    repositoryPath: string | null;
    worktreePath: string | null;
    codexThreadId: string | null;
    model: string;
  },
): Promise<CodexSessionRuntime> {
  const worktree = input.worktreePath ?? (await createCodexWorkingDirectory(input)).worktreePath;
  console.log(
    `[goat-local-bridge] starting codex app-server in ${worktree} ` +
      `(access=${CODEX_APP_SERVER_ACCESS_MODE}, env_inherit=${CODEX_APP_SERVER_ENV_INHERIT})`,
  );
  const eventContext = {
    localCodexTurnId: input.localCodexTurnId,
    commandId: input.commandId,
  };
  const eventBatcher = new CodexEventBatcher({
    options,
    localCodexSessionId: input.localCodexSessionId,
    context: eventContext,
  });
  let runtime: CodexSessionRuntime | null = null;
  const appServer = new CodexAppServerClient({
    cwd: worktree,
    onNotification: (event) => {
      if (event.method === "turn/started") {
        const turnId =
          readStringPath(event, ["params", "turn", "id"]) ??
          readStringPath(event, ["params", "turnId"]);
        if (runtime && turnId) runtime.activeTurnId = turnId;
      }
      if (event.method === "turn/completed" && runtime) runtime.activeTurnId = null;
      eventBatcher.push(event);
    },
  });
  await appServer.initialize();

  const threadResult = input.codexThreadId
    ? await appServer.request("thread/resume", {
        threadId: input.codexThreadId,
        cwd: worktree,
      })
    : await appServer.request("thread/start", {
        model: input.model,
        cwd: worktree,
      });
  const threadId =
    readStringPath(threadResult, ["thread", "id"]) ??
    input.codexThreadId ??
    readStringPath(threadResult, ["id"]);
  if (!threadId) throw new Error("Codex app-server did not return a thread id.");

  runtime = {
    appServer,
    threadId,
    worktreePath: worktree,
    activeTurnId: null,
    eventContext,
    eventBatcher,
  };
  sessions.set(input.localCodexSessionId, runtime);
  return runtime;
}

async function createCodexWorkingDirectory(input: {
  localCodexSessionId: string;
  repositoryPath: string | null;
}) {
  if (input.repositoryPath) {
    return ensureDetachedHeadWorktree({
      repoPath: input.repositoryPath,
      sessionId: input.localCodexSessionId,
    });
  }

  const workspace = await ensureEmptySessionWorkspace({
    sessionId: input.localCodexSessionId,
  });
  return { worktreePath: workspace.workspacePath };
}

class CodexAppServerClient {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(input: {
    cwd: string;
    onNotification: (event: Record<string, unknown>) => void;
  }) {
    this.proc = spawn("codex", buildCodexAppServerArgs(), {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    this.proc.on("error", (error) => this.rejectAll(error));
    this.proc.on("close", (code) =>
      this.rejectAll(new Error(`codex app-server exited with code ${code ?? "unknown"}.`)),
    );

    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(formatRpcError(message.error)));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      input.onNotification(message);
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: {
        name: "opencompany_goat_local_bridge",
        title: "OpenCompany Goat Local Bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized", {});
  }

  request(method: string, params: Record<string, unknown>) {
    const id = this.nextId++;
    const message = { method, id, params };
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method: string, params: Record<string, unknown>) {
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  close() {
    this.proc.kill("SIGTERM");
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

class CodexEventBatcher {
  private events: Record<string, unknown>[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly input: {
      options: BridgeOptions;
      localCodexSessionId: string;
      context: {
        localCodexTurnId: string | null;
        commandId: string | null;
      };
    },
  ) {}

  push(event: Record<string, unknown>) {
    this.events.push(event);
    if (this.events.length >= 20) {
      void this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      void this.flush();
    }, 200);
  }

  private async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const events = this.events.splice(0);
    if (events.length === 0) return;
    await postJson(this.input.options, "/api/local-codex/bridge/events", {
      localCodexSessionId: this.input.localCodexSessionId,
      localCodexTurnId: this.input.context.localCodexTurnId,
      commandId: this.input.context.commandId,
      events,
    }).catch((error) => {
      console.error("[goat-local-bridge] event post failed:", errorMessage(error));
    });
  }
}

async function acknowledgeCommand(
  options: BridgeOptions,
  command: BridgeCommand,
  body: {
    status: "succeeded" | "failed";
    error?: string | null;
    codexThreadId?: string | null;
    codexTurnId?: string | null;
    worktreePath?: string | null;
  },
) {
  await postJson(
    options,
    `/api/local-codex/bridge/commands/${encodeURIComponent(command.id)}`,
    body,
  );
}

async function postJson<T = unknown>(options: BridgeOptions, path: string, body: unknown) {
  const response = await fetch(`${options.baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

function parseArgs(args: string[]): BridgeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (!arg.startsWith("--")) continue;
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      values.set(arg.slice(2), "true");
      continue;
    }
    values.set(arg.slice(2), next);
    index += 1;
  }

  const baseUrl = values.get("base-url")?.replace(/\/+$/, "");
  const token = values.get("token");
  if (!baseUrl || !token) {
    throw new Error(
      "Usage: bun --filter @opencompany/goat-local-bridge start --base-url <url> --token <token> [--model gpt-5.5]",
    );
  }
  return {
    baseUrl,
    token,
    model: values.get("model") || LOCAL_CODEX_DEFAULT_MODEL,
    name: values.get("name") || "Local Codex bridge",
  };
}

function installSignalHandlers() {
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const runtime of sessions.values()) {
        runtime.appServer.close();
      }
      sessions.clear();
      process.exit(0);
    });
  }
}

function textInput(text: string) {
  return [{ type: "text", text }];
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringPath(value: unknown, path: string[]) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return readString(current);
}

function formatRpcError(error: unknown) {
  if (!error || typeof error !== "object") return "Codex app-server request failed.";
  const record = error as Record<string, unknown>;
  return readString(record.message) ?? JSON.stringify(record);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(`[goat-local-bridge] ${errorMessage(error)}`);
  process.exitCode = 1;
});
