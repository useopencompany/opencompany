import { getDb } from "@opencompany/db/client";
import { workspaces } from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { eq } from "drizzle-orm";
import { sendSlackInviteEmail } from "@/lib/email/slack-invite";
import { getWorkspaceSlackChannel, markActive, markFailed, upsertPending } from "@/lib/slack/data";
import { isSlackSupportConfigured, provisionSupportChannel } from "@/lib/slack/support-client";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

type StepLike = { run: <T>(label: string, fn: () => Promise<T> | T) => Promise<T> };
type EventLike = {
  data: {
    workspaceId: string;
    userId: string;
    customerEmail: string;
    firstName?: string | null;
  };
};

export async function runProvisionSlackSupport(args: {
  event: EventLike;
  step: StepLike;
  // optional injected workspace for tests; loaded from the DB in production
  workspace?: { id: string; name: string };
}) {
  const { event, step } = args;
  const { workspaceId, userId, customerEmail, firstName } = event.data;

  const existing = await step.run("ensure-row", () => upsertPending(workspaceId));
  if (existing.status === "active") {
    logger.info("Slack support channel already active — short-circuit", {
      event: "opencompany.slack_support_channel_short_circuit",
      workspace_id: workspaceId,
    });
    return { status: "active" as const, shortCircuited: true };
  }

  // Missing env (e.g. local dev) must not throw on every onboarding: no-op to failed.
  if (!isSlackSupportConfigured()) {
    await step.run("mark-not-configured", () =>
      markFailed(workspaceId, "SLACK_SUPPORT_BOT_TOKEN not configured"),
    );
    logger.warn("Slack support not configured — feature off", {
      event: "opencompany.slack_support_not_configured",
      workspace_id: workspaceId,
    });
    return { status: "failed" as const, reason: "not_configured" };
  }

  const workspace =
    args.workspace ??
    (await step.run("load-workspace", async () => {
      const db = getDb();
      const [ws] = await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (!ws) throw new Error(`Workspace ${workspaceId} not found`);
      return ws;
    }));

  let inviteUrl: string | null = null;
  try {
    const result = await step.run("provision", () =>
      provisionSupportChannel({ workspace, customerEmail }),
    );
    inviteUrl = result.inviteUrl;
    await step.run("mark-active", () =>
      markActive({
        workspaceId,
        slackChannelId: result.channelId,
        slackTeamId: result.teamId,
        inviteUrl: result.inviteUrl,
      }),
    );
  } catch (error) {
    await step.run("mark-failed", () =>
      markFailed(workspaceId, error instanceof Error ? error.message : "Unknown Slack error"),
    );
    captureException(error, {
      event: "opencompany.slack_support_provision_failed",
      workspace_id: workspaceId,
    });
    throw error; // let Inngest retry transient failures
  }

  await step.run("dispatch-email", async () => {
    const row = await getWorkspaceSlackChannel(workspaceId);
    if (row?.status !== "active" || !row.inviteUrl) return { dispatched: false };
    await sendSlackInviteEmail({
      userId,
      workspaceId,
      email: customerEmail,
      firstName: firstName ?? null,
      inviteUrl: row.inviteUrl,
    });
    return { dispatched: true };
  });

  return { status: "active" as const, inviteUrl };
}
