import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  type SlackChannelStatus,
  users,
  workspaceSlackChannels,
  workspaces,
} from "@opencompany/db/schema";
import { and, asc, eq, gt, lt, ne, or } from "drizzle-orm";

export type WorkspaceSlackChannel = {
  status: SlackChannelStatus;
  inviteUrl: string | null;
  slackChannelId: string | null;
  error: string | null;
};

export async function getWorkspaceSlackChannel(
  workspaceId: string,
): Promise<WorkspaceSlackChannel | null> {
  const db = getDb();
  const [found] = await db
    .select({
      status: workspaceSlackChannels.status,
      inviteUrl: workspaceSlackChannels.inviteUrl,
      slackChannelId: workspaceSlackChannels.slackChannelId,
      error: workspaceSlackChannels.error,
    })
    .from(workspaceSlackChannels)
    .where(eq(workspaceSlackChannels.workspaceId, workspaceId))
    .limit(1);
  return found ?? null;
}

// Idempotent: the unique workspaceId index means a concurrent/retried insert is a
// no-op, so there is never a second channel row for a workspace. A previously `failed`
// row is reset to `pending` so a re-dispatch can recover (e.g. Slack was configured
// after the first attempt); `active` and `pending` rows are left untouched so a working
// channel is never downgraded.
export async function upsertPending(workspaceId: string): Promise<WorkspaceSlackChannel> {
  const db = getDb();
  await db
    .insert(workspaceSlackChannels)
    .values({ id: `wsc_${randomUUID()}`, workspaceId, status: "pending" })
    .onConflictDoNothing({ target: workspaceSlackChannels.workspaceId });
  await db
    .update(workspaceSlackChannels)
    .set({ status: "pending", error: null, updatedAt: new Date() })
    .where(
      and(
        eq(workspaceSlackChannels.workspaceId, workspaceId),
        eq(workspaceSlackChannels.status, "failed"),
      ),
    );
  const row = await getWorkspaceSlackChannel(workspaceId);
  if (!row) {
    // The row is missing right after an idempotent insert — a genuine DB/FK fault
    // (the workspaceId is included so callers can tell this from a benign race).
    throw new Error(`Failed to upsert workspace_slack_channels row for workspace ${workspaceId}`);
  }
  return row;
}

// Persist the Slack channel id as soon as it is created, BEFORE the remaining
// provisioning calls. On an Inngest retry this lets the create step resume the
// existing channel instead of minting a second (orphaned) one.
export async function setSlackChannelId(input: {
  workspaceId: string;
  slackChannelId: string;
  slackTeamId: string | null;
}): Promise<void> {
  const db = getDb();
  await db
    .update(workspaceSlackChannels)
    .set({
      slackChannelId: input.slackChannelId,
      slackTeamId: input.slackTeamId,
      updatedAt: new Date(),
    })
    .where(eq(workspaceSlackChannels.workspaceId, input.workspaceId));
}

export async function markActive(input: {
  workspaceId: string;
  slackChannelId: string;
  slackTeamId: string | null;
  inviteUrl: string | null;
}): Promise<void> {
  const db = getDb();
  await db
    .update(workspaceSlackChannels)
    .set({
      status: "active",
      slackChannelId: input.slackChannelId,
      slackTeamId: input.slackTeamId,
      inviteUrl: input.inviteUrl,
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(workspaceSlackChannels.workspaceId, input.workspaceId));
}

export async function markFailed(workspaceId: string, error: string): Promise<void> {
  const db = getDb();
  // Never downgrade an already-active channel: a late/duplicate failure path must not
  // clobber a working row (belt-and-suspenders alongside per-workspace concurrency).
  await db
    .update(workspaceSlackChannels)
    .set({ status: "failed", error: error.slice(0, 500), updatedAt: new Date() })
    .where(
      and(
        eq(workspaceSlackChannels.workspaceId, workspaceId),
        ne(workspaceSlackChannels.status, "active"),
      ),
    );
}

export type RecoverableSlackChannel = {
  workspaceId: string;
  userId: string;
  customerEmail: string;
  firstName: string | null;
};

// Channels the recovery sweep should re-provision. Joined with the workspace owner so the
// provisioning event can be reconstructed. Oldest-first + capped so a large backlog drains
// fairly without starving the tail. Two cases:
// - `failed`: retry, but only after `failedRetryBefore` (let Inngest's own retries finish
//   first) and only while newer than `failedMaxAgeAfter` (give up on permanently-failed rows
//   so they stop being swept forever).
// - `pending`: stuck past `stalePendingBefore` (a crashed/lost worker).
export async function listRecoverableSlackChannels(
  bounds: { failedRetryBefore: Date; failedMaxAgeAfter: Date; stalePendingBefore: Date },
  limit = 50,
): Promise<RecoverableSlackChannel[]> {
  const db = getDb();
  return db
    .select({
      workspaceId: workspaceSlackChannels.workspaceId,
      userId: users.id,
      customerEmail: users.email,
      firstName: users.firstName,
    })
    .from(workspaceSlackChannels)
    .innerJoin(workspaces, eq(workspaces.id, workspaceSlackChannels.workspaceId))
    .innerJoin(users, eq(users.id, workspaces.createdByUserId))
    .where(
      or(
        and(
          eq(workspaceSlackChannels.status, "failed"),
          lt(workspaceSlackChannels.updatedAt, bounds.failedRetryBefore),
          gt(workspaceSlackChannels.createdAt, bounds.failedMaxAgeAfter),
        ),
        and(
          eq(workspaceSlackChannels.status, "pending"),
          lt(workspaceSlackChannels.updatedAt, bounds.stalePendingBefore),
        ),
      ),
    )
    .orderBy(asc(workspaceSlackChannels.updatedAt))
    .limit(limit);
}
