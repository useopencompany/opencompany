import { shellQuote } from "@opencompany/agent-runtime";
import type { CodexReasoningEffort } from "@opencompany/agent-runtime/types";
import { CLAUDE_CODE_CLI_PACKAGE, CLAUDE_CODE_CLI_VERSION } from "./claude-code-version";
import {
  commandExitResult,
  guardCommandStreamCallbacks,
  isCommandTimeoutError,
  type SandboxHandle,
} from "./sandbox";

// The npm prefix is kept away from ~/.claude on purpose: that directory is Claude
// Code's config/session store and must survive across turns for `--resume`.
const CLAUDE_CLI_PREFIX = '"$HOME/.claude-cli"';
const CLAUDE_BIN_PATH = '"$HOME/.claude-cli/bin"';
const CLAUDE_MAX_TURNS = 250;
const ABORT_POLL_INTERVAL_MS = 1_000;
const STDERR_TAIL_LIMIT = 4_000;

// Any of these silently outrank CLAUDE_CODE_OAUTH_TOKEN and flip the session from
// subscription limits to metered API billing. They are stripped from the command env
// and unset in the shell as a hard guarantee.
const FORBIDDEN_ANTHROPIC_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

export type ClaudeCodeCliAuth = {
  kind: "oauth";
  token: string;
  subscriptionType: string | null;
  rateLimitTier: string | null;
};

export async function ensureClaudeInstalled(sandbox: SandboxHandle) {
  const check = await sandbox.commands.run(
    `export PATH=${CLAUDE_BIN_PATH}:"$PATH" && claude --version 2>/dev/null || true`,
    { timeoutMs: 30_000 },
  );
  if (String(check.stdout ?? "").includes(CLAUDE_CODE_CLI_VERSION)) return;
  await sandbox.commands.run(
    [
      `npm install -g --prefix ${CLAUDE_CLI_PREFIX} ${shellQuote(CLAUDE_CODE_CLI_PACKAGE)}`,
      `export PATH=${CLAUDE_BIN_PATH}:"$PATH"`,
      `claude --version | grep -F ${shellQuote(CLAUDE_CODE_CLI_VERSION)}`,
    ].join(" && "),
    { timeoutMs: 180_000 },
  );
}

export function buildClaudeCommandEnv(input: {
  auth: ClaudeCodeCliAuth;
  githubEnv?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {
    ...(input.githubEnv ?? {}),
    CLAUDE_CODE_OAUTH_TOKEN: input.auth.token,
    ...(input.auth.subscriptionType
      ? { CLAUDE_CODE_SUBSCRIPTION_TYPE: input.auth.subscriptionType }
      : {}),
    ...(input.auth.rateLimitTier ? { CLAUDE_CODE_RATE_LIMIT_TIER: input.auth.rateLimitTier } : {}),
  };
  for (const key of FORBIDDEN_ANTHROPIC_ENV_KEYS) delete env[key];
  return env;
}

export function buildClaudeTurnCommand(input: {
  workdir: string;
  promptPath: string;
  model: string | null;
  reasoningEffort: CodexReasoningEffort | null;
  resumeSessionId: string | null;
}) {
  const args = [
    "claude",
    "-p",
    `"$(cat ${shellQuote(input.promptPath)})"`,
    "--output-format stream-json",
    "--verbose",
    "--permission-mode bypassPermissions",
    `--max-turns ${CLAUDE_MAX_TURNS}`,
    ...(input.model ? [`--model ${shellQuote(input.model)}`] : []),
    ...(input.reasoningEffort ? [`--effort ${shellQuote(input.reasoningEffort)}`] : []),
    ...(input.resumeSessionId ? [`--resume ${shellQuote(input.resumeSessionId)}`] : []),
  ];
  return [
    `cd ${shellQuote(input.workdir)}`,
    `unset ${FORBIDDEN_ANTHROPIC_ENV_KEYS.join(" ")}`,
    `export PATH=${CLAUDE_BIN_PATH}:"$PATH"`,
    args.join(" "),
  ].join(" && ");
}

export type ClaudeCodeCliRunResult = {
  exitCode: number | null;
  timedOut: boolean;
  killed: boolean;
  stderrTail: string;
};

// Runs one `claude -p` turn as a background command so an interrupt/handoff can kill
// the process mid-run, and streams parsed stream-json lines to the caller.
export async function runClaudeCodeCliProcess(input: {
  sandbox: SandboxHandle;
  command: string;
  envs: Record<string, string>;
  timeoutMs: number;
  redact: (value: string) => string;
  checkAbort: () => Promise<void>;
  onEvent: (event: Record<string, unknown>) => Promise<void>;
}): Promise<ClaudeCodeCliRunResult> {
  let stdoutBuffer = "";
  let stderrTail = "";

  const handleLine = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // stream-json stdout should be pure NDJSON; anything else is noise.
      return;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      await input.onEvent(parsed as Record<string, unknown>);
    }
  };

  const guarded = guardCommandStreamCallbacks({
    onStdout: async (data: string) => {
      stdoutBuffer += input.redact(data);
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        await handleLine(line);
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    },
    onStderr: async (data: string) => {
      stderrTail = (stderrTail + input.redact(data)).slice(-STDERR_TAIL_LIMIT);
    },
  });

  const handle = await input.sandbox.commands.run(input.command, {
    background: true,
    envs: input.envs,
    timeoutMs: input.timeoutMs,
    ...guarded.options,
  });

  type WaitOutcome =
    | { kind: "result"; exitCode: number | null }
    | { kind: "timeout" }
    | { kind: "error"; error: unknown };
  const waitPromise: Promise<WaitOutcome> = handle
    .wait()
    .then((result): WaitOutcome => ({ kind: "result", exitCode: result.exitCode ?? null }))
    .catch((error): WaitOutcome => {
      const exitResult = commandExitResult(error);
      if (exitResult) {
        return {
          kind: "result",
          exitCode: typeof exitResult.exitCode === "number" ? exitResult.exitCode : null,
        };
      }
      if (isCommandTimeoutError(error)) return { kind: "timeout" };
      return { kind: "error", error };
    });

  let killed = false;
  let outcome: WaitOutcome;
  while (true) {
    const settled = await Promise.race([
      waitPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ABORT_POLL_INTERVAL_MS)),
    ]);
    if (settled) {
      outcome = settled;
      break;
    }
    try {
      await input.checkAbort();
    } catch (abortError) {
      killed = true;
      await handle.kill().catch(() => false);
      await waitPromise.catch(() => undefined);
      throw abortError;
    }
  }

  await guarded.rethrow();
  if (stdoutBuffer.trim()) await handleLine(stdoutBuffer);
  if (outcome.kind === "error") throw outcome.error;
  return {
    exitCode: outcome.kind === "result" ? outcome.exitCode : null,
    timedOut: outcome.kind === "timeout",
    killed,
    stderrTail,
  };
}
