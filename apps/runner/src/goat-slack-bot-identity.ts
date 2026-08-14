import { getDb } from "@opencompany/db/client";
import type { GoatWorkspaceRole } from "@opencompany/db/goat-schema";
import { goatUsers } from "@opencompany/db/goat-schema";
import { getGoatWorkspaceRole } from "@opencompany/db/goat-workspaces";
import { slackApiRequest } from "@opencompany/goat-agent/integrations/slack";
import { eq, sql } from "drizzle-orm";

export type GoatSlackMappedMember = {
  workosUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  timezone: string;
  role: GoatWorkspaceRole;
};

// Who is asking in Slack, resolved against the installing goat workspace.
// "member" carries the mapped goat user (attribution, brain access, action
// connections); anything else degrades to the workspace fallback identity in
// channels and to a polite refusal in DMs.
export type GoatSlackSenderResolution =
  | { kind: "member"; member: GoatSlackMappedMember }
  | {
      kind: "unmapped";
      reason: "bot" | "no_email" | "no_match" | "not_in_workspace" | "lookup_failed";
    };

const SENDER_CACHE_TTL_MS = 10 * 60 * 1000;
const SENDER_CACHE_MAX_ENTRIES = 500;

type SenderCacheEntry = {
  resolution: GoatSlackSenderResolution;
  expiresAt: number;
};

// Per-lambda-instance only: a cold instance pays one users.info call plus one
// indexed query, which is cheap enough not to warrant a DB cache table.
const senderCache = new Map<string, SenderCacheEntry>();

export function clearGoatSlackSenderCacheForTests() {
  senderCache.clear();
}

export async function resolveGoatSlackSender(input: {
  botToken: string;
  teamId: string;
  slackUserId: string;
  workspaceId: string;
  now?: () => number;
}): Promise<GoatSlackSenderResolution> {
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
}): Promise<GoatSlackSenderResolution> {
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
      workosUserId: goatUsers.workosUserId,
      email: goatUsers.email,
      firstName: goatUsers.firstName,
      lastName: goatUsers.lastName,
      timezone: goatUsers.timezone,
    })
    .from(goatUsers)
    .where(sql`lower(${goatUsers.email}) = ${email.toLowerCase()}`)
    .limit(2);
  if (rows.length !== 1) return { kind: "unmapped", reason: "no_match" };
  const user = rows[0];
  if (!user) return { kind: "unmapped", reason: "no_match" };

  // A goat user outside the installing workspace is treated exactly like a
  // stranger — no cross-workspace attribution.
  const role = await getGoatWorkspaceRole({
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

export type GoatUserBasics = {
  email: string;
  firstName: string | null;
  lastName: string | null;
  timezone: string;
};

// Prompt user-context for the fallback (installing admin) identity.
export async function getGoatUserBasics(userWorkosId: string): Promise<GoatUserBasics | null> {
  const rows = await getDb()
    .select({
      email: goatUsers.email,
      firstName: goatUsers.firstName,
      lastName: goatUsers.lastName,
      timezone: goatUsers.timezone,
    })
    .from(goatUsers)
    .where(eq(goatUsers.workosUserId, userWorkosId))
    .limit(1);
  const user = rows[0];
  if (!user) return null;
  return { ...user, timezone: user.timezone || "UTC" };
}
