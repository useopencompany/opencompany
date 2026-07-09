type LocalCodexStandaloneLauncherInput = {
  baseUrl: string;
  token: string;
  name: string;
  model?: string | null;
};

type NormalizedLocalCodexStandaloneLauncherInput = {
  baseUrl: string;
  token: string;
  name: string;
  model: string;
};

const DEFAULT_LOCAL_CODEX_MODEL = "gpt-5.5";

export function buildLocalCodexStandaloneLauncher(input: LocalCodexStandaloneLauncherInput) {
  const model = input.model?.trim() || DEFAULT_LOCAL_CODEX_MODEL;
  const command = `/bin/zsh -c ${shellToken(buildLauncherShellScript({ ...input, model }))}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Window Settings</key>
  <array>
    <dict>
      <key>name</key>
      <string>OpenCompany Goat Local Codex Bridge</string>
      <key>type</key>
      <string>Window Settings</string>
      <key>CommandString</key>
      <string>${xmlText(command)}</string>
      <key>RunCommandAsShell</key>
      <true/>
      <key>shellExitAction</key>
      <integer>0</integer>
    </dict>
  </array>
</dict>
</plist>
`;
}

function buildLauncherShellScript(input: NormalizedLocalCodexStandaloneLauncherInput) {
  return `set -euo pipefail

BRIDGE_DIR="$HOME/.opencompany/goat"
BRIDGE_SCRIPT="$BRIDGE_DIR/local-codex-bridge.mjs"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

mkdir -p "$BRIDGE_DIR"
cat > "$BRIDGE_SCRIPT" <<'OPENCOMPANY_GOAT_LOCAL_CODEX_BRIDGE'
${STANDALONE_BRIDGE_SOURCE}
OPENCOMPANY_GOAT_LOCAL_CODEX_BRIDGE
chmod 700 "$BRIDGE_SCRIPT"

echo "Starting OpenCompany Goat Local Codex bridge..."
echo "Keep this terminal window open while using Local Codex."
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required. Install Node, then open this launcher again."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Node.js 20 or newer is required. Current version: $(node -v)"
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI is required. Install or sign in to Codex, then open this launcher again."
  exit 1
fi

node "$BRIDGE_SCRIPT" \\
  --base-url ${shellToken(input.baseUrl.replace(/\/+$/, ""))} \\
  --token ${shellToken(input.token)} \\
  --model ${shellToken(input.model)} \\
  --name ${shellToken(input.name)}
`;
}

function shellToken(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function xmlText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const STANDALONE_BRIDGE_SOURCE = String.raw`import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

const LOCAL_CODEX_DEFAULT_MODEL = "gpt-5.5";
const CODEX_APP_SERVER_ENV_INHERIT = "all";
const sessions = new Map();
let shuttingDown = false;

installSignalHandlers();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await postJson(options, "/api/local-codex/bridge/heartbeat", { name: options.name });
  console.log("[goat-local-bridge] connected to " + options.baseUrl);

  while (!shuttingDown) {
    try {
      const response = await postJson(options, "/api/local-codex/bridge/commands", {
        limit: 5,
        name: options.name,
      });
      for (const command of response.commands || []) {
        await handleCommand(options, command);
      }
    } catch (error) {
      console.error("[goat-local-bridge] poll failed:", errorMessage(error));
      await sleep(2000);
    }
  }
}

async function handleCommand(options, command) {
  console.log(
    "[goat-local-bridge] handling " +
      command.kind +
      " command " +
      command.id +
      " for " +
      command.localCodexSessionId,
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
        "[goat-local-bridge] started turn for " +
          command.localCodexSessionId +
          " in " +
          result.worktreePath,
      );
      return;
    }

    const runtime = sessions.get(command.localCodexSessionId);
    if (!runtime) {
      if (command.kind === "interrupt" || command.kind === "close") {
        await acknowledgeCommand(options, command, { status: "succeeded" });
        console.log(
          "[goat-local-bridge] completed " +
            command.kind +
            " command " +
            command.id +
            "; runtime was already inactive",
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
    console.log("[goat-local-bridge] completed " + command.kind + " command " + command.id);
  } catch (error) {
    console.error("[goat-local-bridge] command " + command.id + " failed: " + errorMessage(error));
    await acknowledgeCommand(options, command, {
      status: "failed",
      error: errorMessage(error),
    });
  }
}

async function startTurn(options, command) {
  const prompt = readString(command.payload.prompt);
  const repositoryPath = readString(command.payload.repositoryPath);
  if (!prompt) throw new Error("Start command is missing a prompt.");

  const existing = sessions.get(command.localCodexSessionId);
  const worktreePath = readString(command.payload.worktreePath);
  const runtime =
    existing ||
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
  const turnId = readStringPath(turnResult, ["turn", "id"]) || readStringPath(turnResult, ["id"]);
  runtime.activeTurnId = turnId;

  return {
    threadId: runtime.threadId,
    turnId,
    worktreePath: runtime.worktreePath,
  };
}

async function createSessionRuntime(options, input) {
  const worktree =
    input.worktreePath || (await createCodexWorkingDirectory(input)).worktreePath;
  console.log(
    "[goat-local-bridge] starting codex app-server in " +
      worktree +
      " (access=dangerously-bypass-approvals-and-sandbox, env_inherit=" +
      CODEX_APP_SERVER_ENV_INHERIT +
      ")",
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
  let runtime = null;
  const appServer = new CodexAppServerClient({
    cwd: worktree,
    onNotification: (event) => {
      if (event.method === "turn/started") {
        const turnId =
          readStringPath(event, ["params", "turn", "id"]) ||
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
    readStringPath(threadResult, ["thread", "id"]) ||
    input.codexThreadId ||
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

async function createCodexWorkingDirectory(input) {
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
  constructor(input) {
    this.nextId = 1;
    this.pending = new Map();
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
      this.rejectAll(new Error("codex app-server exited with code " + (code || "unknown") + ".")),
    );

    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
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

  request(method, params) {
    const id = this.nextId++;
    const message = { method, id, params };
    this.proc.stdin.write(JSON.stringify(message) + "\n");
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ method, params }) + "\n");
  }

  close() {
    this.proc.kill("SIGTERM");
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

class CodexEventBatcher {
  constructor(input) {
    this.input = input;
    this.events = [];
    this.timer = null;
  }

  push(event) {
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

  async flush() {
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

async function acknowledgeCommand(options, command, body) {
  await postJson(
    options,
    "/api/local-codex/bridge/commands/" + encodeURIComponent(command.id),
    body,
  );
}

async function postJson(options, requestPath, body) {
  const response = await fetch(options.baseUrl + requestPath, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + options.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(response.status + " " + (await response.text()));
  }
  return response.json();
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || !arg.startsWith("--")) continue;
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      values.set(arg.slice(2), "true");
      continue;
    }
    values.set(arg.slice(2), next);
    index += 1;
  }

  const baseUrl = (values.get("base-url") || "").replace(/\/+$/, "");
  const token = values.get("token");
  if (!baseUrl || !token) {
    throw new Error(
      "Usage: node local-codex-bridge.mjs --base-url <url> --token <token> [--model gpt-5.5]",
    );
  }
  return {
    baseUrl,
    token,
    model: values.get("model") || LOCAL_CODEX_DEFAULT_MODEL,
    name: values.get("name") || "Local Codex bridge",
  };
}

function buildCodexAppServerArgs() {
  return [
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    "shell_environment_policy.inherit=" + CODEX_APP_SERVER_ENV_INHERIT,
    "app-server",
    "--listen",
    "stdio://",
  ];
}

function installSignalHandlers() {
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
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

function textInput(text) {
  return [{ type: "text", text }];
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringPath(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = current[key];
  }
  return readString(current);
}

function formatRpcError(error) {
  if (!error || typeof error !== "object") return "Codex app-server request failed.";
  return readString(error.message) || JSON.stringify(error);
}

function validateLocalRepoPath(input) {
  const homeDir = path.resolve(input.homeDir || homedir());
  const repoPath = path.resolve(input.repoPath);
  if (!path.isAbsolute(input.repoPath)) {
    return { ok: false, error: "Repository path must be absolute." };
  }
  if (!isPathInside(repoPath, homeDir)) {
    return { ok: false, error: "Repository path must be under $HOME." };
  }
  return { ok: true, repoPath };
}

function buildWorktreePlan(input) {
  const homeDir = path.resolve(input.homeDir || homedir());
  const repoPath = path.resolve(input.repoPath);
  const safeSessionId = safePathSegment(input.sessionId);
  const worktreePath = path.join(homeDir, ".opencompany", "goat", "worktrees", safeSessionId);
  return {
    repoPath,
    worktreePath,
    gitArgs: ["-C", repoPath, "worktree", "add", "--detach", worktreePath, "HEAD"],
  };
}

function buildSessionWorkspacePlan(input) {
  const homeDir = path.resolve(input.homeDir || homedir());
  const safeSessionId = safePathSegment(input.sessionId);
  return {
    workspacePath: path.join(homeDir, ".opencompany", "goat", "sessions", safeSessionId),
  };
}

async function resolveGitRepoRoot(repoPath) {
  const root = await runBuffered("git", ["-C", repoPath, "rev-parse", "--show-toplevel"]);
  return root.trim();
}

async function ensureDetachedHeadWorktree(input) {
  const validation = validateLocalRepoPath({ repoPath: input.repoPath, homeDir: input.homeDir });
  if (!validation.ok) throw new Error(validation.error);

  const repoRoot = await resolveGitRepoRoot(validation.repoPath);
  const rootValidation = validateLocalRepoPath({ repoPath: repoRoot, homeDir: input.homeDir });
  if (!rootValidation.ok) throw new Error(rootValidation.error);

  const plan = buildWorktreePlan({
    repoPath: rootValidation.repoPath,
    sessionId: input.sessionId,
    homeDir: input.homeDir,
  });
  await mkdir(path.dirname(plan.worktreePath), { recursive: true });
  await runBuffered("git", plan.gitArgs, { allowExistingWorktree: true });
  return plan;
}

async function ensureEmptySessionWorkspace(input) {
  const plan = buildSessionWorkspacePlan(input);
  await mkdir(plan.workspacePath, { recursive: true });
  return plan;
}

function safePathSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isPathInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function runBuffered(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    const message = stderr || stdout || command + " exited with code " + (code || "unknown") + ".";
    if (
      options.allowExistingWorktree &&
      /already exists|is a missing but already registered worktree/i.test(message)
    ) {
      return stdout;
    }
    throw new Error(message.trim());
  }
  return stdout;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error("[goat-local-bridge] " + errorMessage(error));
  process.exitCode = 1;
});
`;
