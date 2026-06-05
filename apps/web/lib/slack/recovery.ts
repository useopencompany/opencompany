import { createLogger } from "@opencompany/observability";
import { listRecoverableSlackChannels } from "@/lib/slack/data";
import { dispatchSlackSupportChannelRequested } from "@/lib/slack/events";
import { isSlackSupportConfigured } from "@/lib/slack/support-client";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

// Hourly recovery sweep. Re-dispatches provisioning for workspaces stuck in `failed`
// (or long-`pending`). Pairs with `upsertPending` resetting `failed`→`pending`, so the
// re-dispatched provisioning heals them. Without this, a failed workspace (transient
// Slack error past retries, or onboarded before SLACK_SUPPORT_* was configured) would
// never get a support channel.
export const SLACK_SUPPORT_RECOVERY_CRON = "0 * * * *";

// A `pending` row older than this is treated as stuck (worker crashed mid-provision).
const STALE_PENDING_MS = 60 * 60 * 1000;

type StepLike = { run: <T>(label: string, fn: () => Promise<T> | T) => Promise<T> };

export async function runSlackSupportRecoverySweep(
  step: StepLike,
): Promise<{ redispatched: number }> {
  // Feature off → nothing to recover (provisioning would just no-op to failed again).
  if (!isSlackSupportConfigured()) return { redispatched: 0 };

  const rows = await step.run("list-recoverable", () =>
    // Date.now() inside the step so the result is memoized deterministically on replay.
    listRecoverableSlackChannels(new Date(Date.now() - STALE_PENDING_MS)),
  );
  if (rows.length === 0) return { redispatched: 0 };

  for (const row of rows) {
    await step.run(`redispatch-${row.workspaceId}`, () =>
      dispatchSlackSupportChannelRequested({
        workspaceId: row.workspaceId,
        userId: row.userId,
        customerEmail: row.customerEmail,
        firstName: row.firstName,
      }),
    );
  }

  logger.info("Re-dispatched Slack support provisioning for stuck workspaces", {
    event: "opencompany.slack_support_recovery_swept",
    count: rows.length,
  });
  return { redispatched: rows.length };
}
