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

// Don't re-dispatch a failure until it's been failed at least this long — let the
// provisioning function's own Inngest retries finish before the sweep piles on.
const FAILED_RETRY_DELAY_MS = 15 * 60 * 1000;
// Stop re-dispatching failures older than this: a permanently-failing workspace gives up
// instead of being re-provisioned every hour forever.
const FAILED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// A `pending` row older than this is treated as stuck — comfortably above the provisioning
// retry window AND larger than the hourly cron interval, so a slow-but-alive run isn't swept.
const STALE_PENDING_MS = 2 * 60 * 60 * 1000;

type StepLike = { run: <T>(label: string, fn: () => Promise<T> | T) => Promise<T> };

export async function runSlackSupportRecoverySweep(
  step: StepLike,
): Promise<{ redispatched: number }> {
  // Feature off → nothing to recover (provisioning would just no-op to failed again).
  if (!isSlackSupportConfigured()) return { redispatched: 0 };

  const rows = await step.run("list-recoverable", () => {
    // Date.now() inside the step so the bounds (and the row set) are memoized on replay.
    const now = Date.now();
    return listRecoverableSlackChannels({
      failedRetryBefore: new Date(now - FAILED_RETRY_DELAY_MS),
      failedMaxAgeAfter: new Date(now - FAILED_MAX_AGE_MS),
      stalePendingBefore: new Date(now - STALE_PENDING_MS),
    });
  });
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
