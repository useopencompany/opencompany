import { shellQuote } from "@opencompany/agent-runtime";
import {
  CLAUDE_CODE_ACP_ADAPTER_PACKAGE,
  CLAUDE_CODE_ACP_ADAPTER_VERSION,
} from "./claude-code-version";
import type { SandboxHandle } from "./sandbox";

// The npm prefix is kept away from ~/.claude on purpose: that directory is Claude
// Code's config/session store and must survive across turns for `--resume`.
const CLAUDE_CLI_PREFIX = '"$HOME/.claude-cli"';
const CLAUDE_BIN_PATH = '"$HOME/.claude-cli/bin"';

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

export async function ensureClaudeAcpAdapterInstalled(sandbox: SandboxHandle) {
  const check = await sandbox.commands.run(
    `export PATH=${CLAUDE_BIN_PATH}:"$PATH" && claude-agent-acp --version 2>/dev/null || true`,
    { timeoutMs: 30_000 },
  );
  if (String(check.stdout ?? "").trim() === CLAUDE_CODE_ACP_ADAPTER_VERSION) return;
  await sandbox.commands.run(
    [
      `npm install -g --prefix ${CLAUDE_CLI_PREFIX} ${shellQuote(CLAUDE_CODE_ACP_ADAPTER_PACKAGE)}`,
      `export PATH=${CLAUDE_BIN_PATH}:"$PATH"`,
      `test "$(claude-agent-acp --version)" = ${shellQuote(CLAUDE_CODE_ACP_ADAPTER_VERSION)}`,
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

export function buildClaudeAcpCommandEnv(input: {
  auth: ClaudeCodeCliAuth;
  githubEnv?: Record<string, string>;
  model?: string | null;
}) {
  return {
    ...buildClaudeCommandEnv(input),
    ...(input.model ? { ANTHROPIC_MODEL: input.model } : {}),
  };
}

// The bracketed pattern does not occur literally in the cleanup shell's own command line.
// pkill exits 1 when nothing matched, so the command ends with true.
export const KILL_LEFTOVER_CLAUDE_TURN_COMMAND = "pkill -9 -f '[c]laude-agent-acp' || true";

// A hard runner death (crash, OOM kill, SIGKILL at the end of a deploy grace period)
// never reaches handle.kill(), so the background `claude` process survives in the
// sandbox. Reclaiming the turn into the same sandbox would then run two agents in one
// checkout — they race each other (file reverts, duplicate commits and PRs). Every run
// against a reused sandbox must fence off leftover turn processes first.
export async function killLeftoverClaudeTurnProcesses(sandbox: SandboxHandle) {
  await sandbox.commands.run(KILL_LEFTOVER_CLAUDE_TURN_COMMAND, { timeoutMs: 30_000 });
}

export function buildClaudeAcpCommand(workdir: string) {
  return [
    `cd ${shellQuote(workdir)}`,
    `unset ${FORBIDDEN_ANTHROPIC_ENV_KEYS.join(" ")}`,
    `export PATH=${CLAUDE_BIN_PATH}:"$PATH"`,
    "exec claude-agent-acp",
  ].join(" && ");
}
