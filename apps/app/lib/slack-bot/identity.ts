import { slackApiRequest } from "@opencompany/core/integrations/slack";
import { getDb } from "@opencompany/db/client";
import type { WorkspaceRole } from "@opencompany/db/schema";
import { users } from "@opencompany/db/schema";
import { getWorkspaceRole } from "@opencompany/db/workspaces";
import { eq, sql } from "drizzle-orm";

export type SlackMappedMember = {
  workosUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  timezone: string;
  role: WorkspaceRole;
};

// Who is asking in Slack, resolved against the installing goat workspace.
// "member" carries the mapped goat user (attribution, brain access, action
// connections); anything else degrades to the workspace fallback identity in
// channels and to a polite refusal in DMs.
export type SlackSenderResolution =
  | { kind: "member"; member: SlackMappedMember }
  | {
      kind: "unmapped";
      reason: "bot" | "no_email" | "no_match" | "not_in_workspace" | "lookup_failed";
    };

const SENDER_CACHE_TTL_MS = 10 * 60 * 1000;
const SENDER_CACHE_MAX_ENTRIES = 500;

type SenderCacheEntry = {
  resolution: SlackSenderResolution;
  expiresAt: number;
};

// Per-lambda-instance only: a cold instance pays one users.info call plus one
// indexed query, which is cheap enough not to warrant a DB cache table.
const senderCache = new Map<string, SenderCacheEntry>();

export function clearSlackSenderCacheForTests() {
  senderCache.clear();
}

export async function resolveSlackSender(input: {
  botToken: string;
  teamId: string;
  slackUserId: string;
  workspaceId: string;
  now?: () => number;
}): Promise<SlackSenderResolution> {
  const now = input.now ?? Date.now;
  const cacheKey = `${input.teamId}:${input.workspaceId}:${input.slackUserId}`;
  const cached = senderCache.get(cacheKey);
  if (cached && cached.expiresAt > now()) return cached.resolution;

  const resolution = await resolveUncached(input);
  // Lookup failures (rate limits, missing scope) stay uncached so a transient
  // error does not pin a member to the fallback identity for ten minutes.
  if (resolution.kind === "unmapped" && resolution.reason === "lookup_failed") {
    return resolution;
  }
  if (senderCache.size >= SENDER_CACHE_MAX_ENTRIES) {
    const oldestKey = senderCache.keys().next().value;
    if (oldestKey !== undefined) senderCache.delete(oldestKey);
  }
  senderCache.set(cacheKey, { resolution, expiresAt: now() + SENDER_CACHE_TTL_MS });
  return resolution;
}

async function resolveUncached(input: {
  botToken: string;
  slackUserId: string;
  workspaceId: string;
}): Promise<SlackSenderResolution> {
  let email: string | null = null;
  try {
    const result = await slackApiRequest<{
      user?: { is_bot?: boolean; profile?: { email?: string } };
    }>({
      method: "users.info",
      token: input.botToken,
      form: { user: input.slackUserId },
    });
    if (result.user?.is_bot) return { kind: "unmapped", reason: "bot" };
    email = result.user?.profile?.email?.trim() || null;
  } catch {
    // Missing users:read/users:read.email on a stale install, or Slack being
    // flaky: degrade to the fallback identity rather than failing the answer.
    return { kind: "unmapped", reason: "lookup_failed" };
  }
  if (!email) return { kind: "unmapped", reason: "no_email" };

  // Ambiguous emails (0 or >1 goat accounts) never map: acting as the wrong
  // person is worse than acting as the workspace.
  const rows = await getDb()
    .select({
      workosUserId: users.workosUserId,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      timezone: users.timezone,
    })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .limit(2);
  if (rows.length !== 1) return { kind: "unmapped", reason: "no_match" };
  const user = rows[0];
  if (!user) return { kind: "unmapped", reason: "no_match" };

  // A goat user outside the installing workspace is treated exactly like a
  // stranger — no cross-workspace attribution.
  const role = await getWorkspaceRole({
    userWorkosId: user.workosUserId,
    workspaceId: input.workspaceId,
  });
  if (!role) return { kind: "unmapped", reason: "not_in_workspace" };

  return {
    kind: "member",
    member: {
      workosUserId: user.workosUserId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      timezone: user.timezone || "UTC",
      role,
    },
  };
}

export type UserBasics = {
  email: string;
  firstName: string | null;
  lastName: string | null;
  timezone: string;
};

// Prompt user-context for the fallback (installing admin) identity.
export async function getUserBasics(userWorkosId: string): Promise<UserBasics | null> {
  const rows = await getDb()
    .select({
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      timezone: users.timezone,
    })
    .from(users)
    .where(eq(users.workosUserId, userWorkosId))
    .limit(1);
  const user = rows[0];
  if (!user) return null;
  return { ...user, timezone: user.timezone || "UTC" };
}
