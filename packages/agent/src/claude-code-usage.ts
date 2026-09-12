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
const PROBE_BODY = JSON.stringify({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 1,
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
  const windows = readUsageWindows(response.headers);
  if (windows.length > 0) return { windows, updatedAt: new Date().toISOString() };

  if (response.status === 401 || response.status === 403) {
    throw new ClaudeCodeUsageError(
      "needs_reauth",
      "Reconnect Claude Code to view subscription usage.",
      401,
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

function readUsageWindows(headers: Headers): SubscriptionUsage["windows"] {
  const windows: SubscriptionUsage["windows"] = [];
  for (const [name, value] of headers) {
    const key = UTILIZATION_HEADER.exec(name.toLowerCase())?.[1];
    if (!key) continue;
    const utilization = Number(value);
    const resetAt = Number(headers.get(`anthropic-ratelimit-unified-${key}-reset`));
    // Utilization is a 0..1 fraction and reset is unix seconds. A window without a
    // usable reset is unreadable, never an unused allowance, so it is left out.
    if (!Number.isFinite(utilization) || utilization < 0) continue;
    if (!Number.isInteger(resetAt) || resetAt <= 0 || resetAt > 8_640_000_000) continue;
    windows.push({
      id: `claude-code:${key}`,
      label: WINDOW_LABELS[key] ?? key.replace(/_/g, " "),
      usedPercent: Math.min(100, utilization * 100),
      resetsAt: new Date(resetAt * 1_000).toISOString(),
    });
  }
  return windows.sort((left, right) => windowRank(left.id) - windowRank(right.id));
}

function windowRank(id: string): number {
  const index = WINDOW_ORDER.indexOf(id.slice("claude-code:".length));
  return index === -1 ? WINDOW_ORDER.length : index;
}
