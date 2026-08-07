import {
  type ClaimedOnboardingEmail,
  claimDueOnboardingEmails,
  enrollOnboardingEmails,
  failOnboardingEmail,
  MAX_GOAT_ONBOARDING_EMAIL_ATTEMPTS,
  markOnboardingEmailSent,
  rescheduleOnboardingEmail,
} from "@opencompany/db/onboarding-emails";
import { captureException, createLogger } from "@opencompany/observability";
import { assertResendResponse, getResendClient, trimmed } from "@/lib/email/client";
import { renderOnboardingEmail } from "@/lib/email/templates/onboarding";
import { createEmailUnsubscribeUrl } from "@/lib/email/unsubscribe";

const logger = createLogger({ service: "opencompany-goat", runtime: "server" });

const DEFAULT_WELCOME_FROM = "Louis Morgner <louis@updates.opencompany.cloud>";
const DEFAULT_REPLY_TO = "louis@opencompany.cloud";

const RETRY_BASE_MS = 5 * 60 * 1000; // 5 minutes
const RETRY_MAX_MS = 6 * 60 * 60 * 1000; // 6 hours

type OnboardingEmailConfig =
  | { enabled: true; apiKey: string; from: string; replyTo: string }
  | { enabled: false; reason: "missing_api_key" };

function getOnboardingEmailConfig(): OnboardingEmailConfig {
  const apiKey = trimmed(process.env.RESEND_API_KEY);
  if (!apiKey) {
    return { enabled: false, reason: "missing_api_key" };
  }
  return {
    enabled: true,
    apiKey,
    from: trimmed(process.env.RESEND_WELCOME_FROM) ?? DEFAULT_WELCOME_FROM,
    replyTo: trimmed(process.env.RESEND_REPLY_TO) ?? DEFAULT_REPLY_TO,
  };
}

async function sendOnboardingEmail(
  row: ClaimedOnboardingEmail,
  config: Extract<OnboardingEmailConfig, { enabled: true }>,
) {
  const client = getResendClient(config.apiKey);
  const unsubscribeUrl = createEmailUnsubscribeUrl({ email: row.email });
  const rendered = renderOnboardingEmail(row.step, {
    firstName: row.firstName,
    unsubscribeUrl,
  });

  return assertResendResponse(
    await client.emails.send(
      {
        from: config.from,
        to: row.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        replyTo: config.replyTo,
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
        tags: [
          { name: "category", value: "lifecycle" },
          { name: "sequence", value: "onboarding" },
          { name: "step", value: row.step },
        ],
      },
      // Stable per (step, user): a re-claimed row (e.g. after a crash mid-send)
      // won't produce a duplicate at Resend.
      { idempotencyKey: `goat-onboarding:${row.step}:${row.workosUserId}` },
    ),
    "Unable to send onboarding email",
  );
}

function backoffMs(attempts: number) {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
}

export type OnboardingEmailSweepResult =
  | { status: "skipped"; reason: string }
  | { status: "ok"; claimed: number; sent: number; failed: number; rescheduled: number };

// Claims and sends every due onboarding email. Safe to call concurrently (the
// hourly cron and the inline send at signup both call it) — the DB claim uses
// SKIP LOCKED and each send is idempotent. Pass `workosUserId` to scope the
// sweep to one owner (the inline welcome); omit it for the global cron sweep.
export async function sweepDueOnboardingEmails({
  limit = 100,
  workosUserId,
}: {
  limit?: number;
  workosUserId?: string;
} = {}): Promise<OnboardingEmailSweepResult> {
  const config = getOnboardingEmailConfig();
  if (!config.enabled) {
    logger.info("Skipped onboarding email sweep because Resend is not configured", {
      event: "opencompany.goat_onboarding_email_skipped",
      reason: config.reason,
    });
    return { status: "skipped", reason: config.reason };
  }

  const claimed = await claimDueOnboardingEmails({
    limit,
    ...(workosUserId ? { workosUserId } : {}),
  });
  let sent = 0;
  let failed = 0;
  let rescheduled = 0;

  for (const row of claimed) {
    try {
      const result = await sendOnboardingEmail(row, config);
      await markOnboardingEmailSent(row.id);
      sent += 1;
      logger.info("Sent onboarding email", {
        event: "opencompany.goat_onboarding_email_sent",
        user_id: row.workosUserId,
        step: row.step,
        email_id: result.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      captureException(error, {
        event: "opencompany.goat_onboarding_email_failed",
        user_id: row.workosUserId,
        step: row.step,
        attempts: row.attempts,
      });
      if (row.attempts >= MAX_GOAT_ONBOARDING_EMAIL_ATTEMPTS) {
        await failOnboardingEmail({ id: row.id, error: message });
        failed += 1;
      } else {
        await rescheduleOnboardingEmail({
          id: row.id,
          nextRunAt: new Date(Date.now() + backoffMs(row.attempts)),
          error: message,
        });
        rescheduled += 1;
      }
    }
  }

  return { status: "ok", claimed: claimed.length, sent, failed, rescheduled };
}

// Enrolls a brand-new workspace owner into the sequence and fires the welcome
// email immediately. Best-effort: callers wrap this so a Resend/DB hiccup never
// blocks sign-in, and the hourly cron backstops both the welcome and the
// delayed steps.
export async function enrollOwnerInOnboardingEmails(user: { workosUserId: string }) {
  await enrollOnboardingEmails({ workosUserId: user.workosUserId });
  // Scope to this owner so the inline send only ever delivers their welcome (one
  // Resend round-trip) and never processes another user's backlog during sign-in.
  await sweepDueOnboardingEmails({ limit: 4, workosUserId: user.workosUserId });
}
