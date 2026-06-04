import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { type SlackChannelStatus, workspaceSlackChannels } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";

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
// no-op, so there is never a second channel row for a workspace.
export async function upsertPending(workspaceId: string): Promise<WorkspaceSlackChannel> {
  const db = getDb();
  await db
    .insert(workspaceSlackChannels)
    .values({ id: `wsc_${randomUUID()}`, workspaceId, status: "pending" })
    .onConflictDoNothing({ target: workspaceSlackChannels.workspaceId });
  const row = await getWorkspaceSlackChannel(workspaceId);
  if (!row) throw new Error("Failed to upsert workspace_slack_channels row");
  return row;
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
  await db
    .update(workspaceSlackChannels)
    .set({ status: "failed", error: error.slice(0, 500), updatedAt: new Date() })
    .where(eq(workspaceSlackChannels.workspaceId, workspaceId));
}
