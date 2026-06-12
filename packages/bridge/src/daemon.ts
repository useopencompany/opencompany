import { configPath, loadConfig } from "./config";
import { type BridgeExecutor, createExecutor } from "./executor";
import { deriveGrantRule, evaluatePermission } from "./permissions";
import {
  BRIDGE_WS_PATH,
  type BridgeDecision,
  type BridgeListFilesArgs,
  type BridgeReadFileArgs,
  type BridgeShellArgs,
  type BridgeToolName,
  type BridgeWriteFileArgs,
  type DaemonToRunnerMessage,
  isBridgeToolName,
  type RunnerToDaemonMessage,
} from "./protocol";
import { appendAllowRule, type BridgeSettings, loadSettings, settingsPath } from "./settings";
import { createStatusWriter } from "./status";

// The daemon's connection loop and message handler. The handler is a pure-ish
// function over (message, settings, session grants) so the security behavior is
// unit-testable without a socket.

export type SessionGrants = Map<string, string[]>;

// A handled action worth surfacing in the local status file / menubar activity feed:
// the real outcome of an execute, or a gate-time rule denial (a check that blocks with
// no execute to follow).
export type ActivityEntry = { tool: string; decision: string; summary: string };

export type MessageHandlerOptions = {
  loadSettings: () => BridgeSettings;
  sessionGrants: SessionGrants;
  executor: BridgeExecutor;
  settingsPath: string;
  log?: (line: string) => void;
  onActivity?: (entry: ActivityEntry) => void;
};

export function createMessageHandler(
  opts: MessageHandlerOptions,
): (msg: RunnerToDaemonMessage) => Promise<DaemonToRunnerMessage> {
  const log = opts.log ?? (() => {});
  const emit = opts.onActivity ?? (() => {});

  return async (msg) => {
    if (msg.kind === "ping") {
      return { kind: "pong", id: msg.id };
    }

    if (!isBridgeToolName(msg.tool)) {
      const summary = `unknown tool ${String(msg.tool)}`;
      log(`denied ${summary}`);
      return msg.kind === "check"
        ? { kind: "verdict", id: msg.id, verdict: "deny", summary }
        : {
            kind: "result",
            id: msg.id,
            ok: false,
            error: { code: "invalid_args", message: summary },
            summary,
          };
    }

    const grants = opts.sessionGrants.get(msg.sessionId) ?? [];
    const evaluation = evaluatePermission(
      { tool: msg.tool, args: msg.args, sessionId: msg.sessionId },
      opts.loadSettings(),
      grants,
    );

    if (msg.kind === "check") {
      log(
        `${msg.tool} check → ${evaluation.verdict}${ruleSuffix(evaluation.rule)}: ${evaluation.summary}`,
      );
      // A gate-time rule denial blocks here with no execute to follow, so it is the only
      // place this action reaches the activity feed. allow/ask checks are pre-flight and
      // surface later via their execute result (or stay silent until approved).
      if (evaluation.verdict === "deny") {
        emit({ tool: msg.tool, decision: "denied_by_rule", summary: evaluation.summary });
      }
      return {
        kind: "verdict",
        id: msg.id,
        verdict: evaluation.verdict,
        ...(evaluation.rule !== undefined ? { rule: evaluation.rule } : {}),
        summary: evaluation.summary,
      };
    }

    // Deny always wins — even a freshly relayed user approval cannot override a
    // deny rule, and the grant is not recorded.
    if (evaluation.verdict === "deny") {
      if (evaluation.rule !== undefined) {
        log(`${msg.tool} denied by rule ${evaluation.rule}: ${evaluation.summary}`);
        emit({ tool: msg.tool, decision: "denied_by_rule", summary: evaluation.summary });
        return {
          kind: "result",
          id: msg.id,
          ok: false,
          error: { code: "permission_denied", message: `Denied by rule ${evaluation.rule}.` },
          decision: "denied_by_rule",
          summary: evaluation.summary,
        };
      }
      // A deny without a rule means the args themselves were invalid.
      log(`${msg.tool} rejected: ${evaluation.summary}`);
      return {
        kind: "result",
        id: msg.id,
        ok: false,
        error: { code: "invalid_args", message: evaluation.summary },
        summary: evaluation.summary,
      };
    }

    let decision: BridgeDecision;
    let decidingRule: string | undefined;
    if (msg.grant) {
      if (msg.grant.scope === "session") {
        decidingRule = deriveGrantRule(msg);
        const existing = opts.sessionGrants.get(msg.sessionId);
        if (existing) {
          existing.push(decidingRule);
        } else {
          opts.sessionGrants.set(msg.sessionId, [decidingRule]);
        }
        decision = "approved_session";
      } else if (msg.grant.scope === "always") {
        decidingRule = deriveGrantRule(msg);
        appendAllowRule(decidingRule, opts.settingsPath);
        decision = "approved_always";
      } else {
        decision = "approved_once";
      }
    } else if (evaluation.verdict === "allow") {
      decision = evaluation.rule !== undefined ? "allowed_by_rule" : "allowed_by_mode";
      decidingRule = evaluation.rule;
    } else {
      log(`${msg.tool} needs approval: ${evaluation.summary}`);
      return {
        kind: "result",
        id: msg.id,
        ok: false,
        error: { code: "needs_approval", message: "This action needs user approval." },
        summary: evaluation.summary,
      };
    }

    try {
      const output = await runTool(opts.executor, msg.tool, msg.args);
      log(`${msg.tool} ${describeDecision(decision, decidingRule)}: ${evaluation.summary}`);
      emit({ tool: msg.tool, decision, summary: evaluation.summary });
      return { kind: "result", id: msg.id, ok: true, output, decision, summary: evaluation.summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`${msg.tool} failed (${decision}): ${message}`);
      emit({ tool: msg.tool, decision: "execution_failed", summary: evaluation.summary });
      return {
        kind: "result",
        id: msg.id,
        ok: false,
        error: { code: "execution_failed", message },
        decision,
        summary: evaluation.summary,
      };
    }
  };
}

function runTool(
  executor: BridgeExecutor,
  tool: BridgeToolName,
  args: unknown,
): Promise<unknown> {
  // Arg shapes were validated by evaluatePermission before execution is reached.
  switch (tool) {
    case "local_shell":
      return executor.local_shell(args as BridgeShellArgs);
    case "local_read_file":
      return executor.local_read_file(args as BridgeReadFileArgs);
    case "local_write_file":
      return executor.local_write_file(args as BridgeWriteFileArgs);
    case "local_list_files":
      return executor.local_list_files(args as BridgeListFilesArgs);
  }
}

function ruleSuffix(rule: string | undefined): string {
  return rule !== undefined ? ` by rule ${rule}` : "";
}

function describeDecision(decision: BridgeDecision, rule: string | undefined): string {
  switch (decision) {
    case "allowed_by_rule":
      return `allowed${ruleSuffix(rule)}`;
    case "allowed_by_mode":
      return "allowed by allow-everything mode";
    case "approved_once":
      return "approved by user (once)";
    case "approved_session":
      return `approved by user (session)${ruleSuffix(rule)}`;
    case "approved_always":
      return `approved by user (always)${ruleSuffix(rule)}`;
    default:
      return decision;
  }
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

// Bun's WebSocket accepts custom headers in the second argument; the standard lib
// type only knows about protocols, hence the local constructor type.
type HeaderWebSocketCtor = new (
  url: string,
  opts: { headers: Record<string, string> },
) => WebSocket;

export async function startDaemon(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    logLine(`no device config at ${configPath()} — run \`oc-bridge pair\` first.`);
    process.exitCode = 1;
    return;
  }

  const sessionGrants: SessionGrants = new Map();
  // Observation-only status file the macOS menubar app reads for connection state +
  // recent activity. Seeded with the current mode so the app can show it before any action.
  const status = createStatusWriter({
    deviceName: config.deviceName,
    mode: loadSettings().mode,
  });
  const handler = createMessageHandler({
    loadSettings: () => loadSettings(),
    sessionGrants,
    executor: createExecutor(),
    settingsPath: settingsPath(),
    log: logLine,
    onActivity: (entry) => {
      // Refresh the mode too: the user may have flipped it in the settings file between
      // actions, and the menubar reads mode from here.
      status.setMode(loadSettings().mode);
      status.pushActivity(entry);
    },
  });

  const wsUrl = config.runnerUrl.replace(/^http/, "ws") + BRIDGE_WS_PATH;
  let backoffMs = RECONNECT_MIN_MS;

  const connect = (): void => {
    logLine(`connecting to ${wsUrl} as ${config.deviceName} (${config.deviceId})`);
    const ws = new (WebSocket as unknown as HeaderWebSocketCtor)(wsUrl, {
      headers: {
        authorization: `Bearer ${config.deviceSecret}`,
        "x-device-id": config.deviceId,
      },
    });

    ws.onopen = () => {
      backoffMs = RECONNECT_MIN_MS;
      logLine("connected");
      status.setMode(loadSettings().mode);
      status.setConnected(true);
    };

    ws.onmessage = (event) => {
      void handleRaw(ws, handler, event.data);
    };

    ws.onerror = () => {
      logLine("socket error");
    };

    ws.onclose = (event) => {
      logLine(`disconnected (code ${event.code}) — reconnecting in ${backoffMs / 1000}s`);
      status.setConnected(false);
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
    };
  };

  connect();
  // The socket callbacks drive everything from here; keep the process alive.
  await new Promise<never>(() => {});
}

async function handleRaw(
  ws: WebSocket,
  handler: (msg: RunnerToDaemonMessage) => Promise<DaemonToRunnerMessage>,
  data: unknown,
): Promise<void> {
  let msg: RunnerToDaemonMessage;
  try {
    msg = JSON.parse(String(data)) as RunnerToDaemonMessage;
  } catch {
    logLine("ignoring non-JSON message from runner");
    return;
  }
  if (msg.kind !== "check" && msg.kind !== "execute" && msg.kind !== "ping") {
    logLine(`ignoring message with unknown kind ${String((msg as { kind?: unknown }).kind)}`);
    return;
  }
  const response = await handler(msg);
  ws.send(JSON.stringify(response));
}

function logLine(line: string): void {
  console.log(`[oc-bridge] ${new Date().toISOString()} ${line}`);
}
