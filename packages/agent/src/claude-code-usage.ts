import { loadClaudeCodeCredential } from "@opencompany/db/claude-code-auth";
import type { SubscriptionUsage } from "@opencompany/protocol/schemas";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const OAUTH_BETA = "oauth-2025-04-20";
const ANTHROPIC_VERSION = "2023-06-01";

// Tokens from `claude setup-token` only carry the `user:inference` scope, so the
// account-wide usage endpoint (`/api/oauth/usage`, which requires `user:profile`)
// answers 403 for them. Anthropic returns the same unified subscription windows as
// `anthropic-ratelimit-unified-*` response headers on any inference call, so the
// cheapest possible completion is what we use to read them.
//
// The system block matches what the CLI sends for every other use of this credential
// (see apps/runner/src/claude-code-cli.ts). Anthropic accepts the probe without it
// today; sending it keeps the one request opencompany makes on its own behalf shaped
// like the Claude Code traffic the token was issued for.
const PROBE_BODY = JSON.stringify({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 1,
  system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
  messages: [{ role: "user", content: "." }],
});

const UTILIZATION_HEADER = /^anthropic-ratelimit-unified-(.+)-utilization$/;

// Window keys Anthropic reports today. Unknown keys still render, after these.
const WINDOW_LABELS: Record<string, string> = {
  "5h": "Session",
  "7d": "Weekly",
  "7d_opus": "Weekly (Opus)",
  "7d_sonnet": "Weekly (Sonnet)",
};
const WINDOW_ORDER = Object.keys(WINDOW_LABELS);

export type ClaudeCodeUsageErrorKind = "needs_reauth" | "backend_error";

export class ClaudeCodeUsageError extends Error {
  readonly kind: ClaudeCodeUsageErrorKind;
  readonly statusCode: number;

  constructor(kind: ClaudeCodeUsageErrorKind, message: string, statusCode = 500) {
    super(message);
    this.name = "ClaudeCodeUsageError";
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

export async function fetchClaudeCodeUsage(input: {
  db: Parameters<typeof loadClaudeCodeCredential>[0]["db"];
  userWorkosId: string;
  fetchImpl?: typeof fetch;
}): Promise<SubscriptionUsage> {
  const credential = await loadClaudeCodeCredential({
    db: input.db,
    userWorkosId: input.userWorkosId,
  });
  const token = credential?.status === "connected" ? credential.authJson.token : null;
  if (!token) {
    throw new ClaudeCodeUsageError(
      "needs_reauth",
      "Reconnect Claude Code to view subscription usage.",
      401,
    );
  }

  const response = await (input.fetchImpl ?? fetch)(MESSAGES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": OAUTH_BETA,
      "content-type": "application/json",
      Accept: "application/json",
    },
    body: PROBE_BODY,
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
    cache: "no-store",
  });
  await response.body?.cancel();

  // A rate-limited account still reports its windows, and that reading is exactly
  // what the user opened the card for, so headers win over the response status.
  const reading = readUsageWindows(response.headers);
  if (reading.windows.length > 0) {
    return { windows: reading.windows, updatedAt: new Date().toISOString() };
  }

  if (response.status === 401 || response.status === 403) {
    throw new ClaudeCodeUsageError(
      "needs_reauth",
      "Reconnect Claude Code to view subscription usage.",
      401,
    );
  }
  // Anthropic reported windows we could not read. Saying the account has no limits
  // would tell a subscriber their allowance is unlimited, so this stays an error.
  if (reading.reportedWindows) {
    throw new ClaudeCodeUsageError(
      "backend_error",
      "Claude usage could not be read. Try again shortly.",
      502,
    );
  }
  if (response.ok) {
    // An API-key or Console account has no subscription windows to report.
    return { windows: [], updatedAt: new Date().toISOString() };
  }
  throw new ClaudeCodeUsageError(
    "backend_error",
    response.status === 429
      ? "Claude usage refresh is rate limited. Try again in a minute."
      : "Claude usage is temporarily unavailable. Try again shortly.",
    503,
  );
}

function readUsageWindows(headers: Headers): {
  windows: SubscriptionUsage["windows"];
  reportedWindows: boolean;
} {
  const windows: SubscriptionUsage["windows"] = [];
  let reportedWindows = false;
  for (const [name, value] of headers) {
    const key = UTILIZATION_HEADER.exec(name.toLowerCase())?.[1];
    if (!key) continue;
    reportedWindows = true;
    const utilization = numericHeader(value);
    const resetAt = numericHeader(headers.get(`anthropic-ratelimit-unified-${key}-reset`));
    // Utilization is a 0..1 fraction and reset is unix seconds. A window we cannot
    // read is unreadable, never an unused allowance, so it is left out.
    if (utilization === null || utilization < 0) continue;
    if (resetAt === null || !Number.isInteger(resetAt) || resetAt <= 0) continue;
    if (resetAt > 8_640_000_000) continue;
    windows.push({
      id: `claude-code:${key}`,
      label: WINDOW_LABELS[key] ?? key.replace(/_/g, " "),
      usedPercent: Math.min(100, utilization * 100),
      resetsAt: new Date(resetAt * 1_000).toISOString(),
    });
  }
  windows.sort((left, right) => windowRank(left.id) - windowRank(right.id));
  return { windows, reportedWindows };
}

// `Number("")` and `Number(" ")` are 0, which would read a blank header as a fully
// unused window. Only a header that actually spells a number counts.
function numericHeader(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function windowRank(id: string): number {
  const index = WINDOW_ORDER.indexOf(id.slice("claude-code:".length));
  return index === -1 ? WINDOW_ORDER.length : index;
}
