import { getDb } from "@opencompany/db/client";
import { workspaces } from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { eq } from "drizzle-orm";
import {
  getWorkspaceSlackChannel,
  markActive,
  markFailed,
  setSlackChannelId,
  upsertPending,
} from "@/lib/slack/data";
import {
  createSupportChannel,
  getSupportTeamId,
  inviteCustomerToChannel,
  inviteSupportMembers,
  isSlackSupportConfigured,
  postIntroMessage,
} from "@/lib/slack/support-client";

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
  const { workspaceId, customerEmail } = event.data;

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
    // Each Slack call is its own step so Inngest memoizes it across retries. The
    // channel id is persisted right after creation, so a retry of any later step
    // resumes the SAME channel instead of minting a second (orphaned) one — this is
    // what makes "exactly one channel per workspace" hold at the Slack level too.
    const channelId = await step.run("create-channel", async () => {
      const current = await getWorkspaceSlackChannel(workspaceId);
      if (current?.slackChannelId) return current.slackChannelId;
      const id = await createSupportChannel(workspace);
      await setSlackChannelId({ workspaceId, slackChannelId: id, slackTeamId: getSupportTeamId() });
      return id;
    });

    await step.run("invite-members", () => inviteSupportMembers(channelId));

    inviteUrl = await step.run("invite-customer", () =>
      inviteCustomerToChannel(channelId, customerEmail),
    );

    // Best-effort: a failed intro message must not fail provisioning — the channel and
    // invite already succeeded. Swallow + log instead of throwing.
    await step.run("post-intro", async () => {
      try {
        await postIntroMessage(channelId);
        return { posted: true };
      } catch (error) {
        logger.warn("Slack intro message failed (non-fatal)", {
          event: "opencompany.slack_support_intro_failed",
          workspace_id: workspaceId,
          ...(error instanceof Error ? { error: error.message } : {}),
        });
        return { posted: false };
      }
    });

    await step.run("mark-active", () =>
      markActive({
        workspaceId,
        slackChannelId: channelId,
        slackTeamId: getSupportTeamId(),
        inviteUrl,
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

  // Note: the customer's invite email is sent by Slack itself — conversations.inviteShared
  // with an email recipient triggers Slack's transactional Connect invite. We persist the
  // invite URL above only so the workspace-home "Connect on Slack" card can link to it.
  return { status: "active" as const, inviteUrl };
}
