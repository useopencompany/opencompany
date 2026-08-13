import { captureException, createLogger } from "@opencompany/observability";
import {
  type OnboardingEmailClaimDto,
  OnboardingEmailClaimEnvelopeSchema,
} from "@opencompany/protocol";
import { assertResendResponse, getResendClient, trimmed } from "@/lib/email/client";
import { renderOnboardingEmail } from "@/lib/email/templates/onboarding";
import { createGoatEmailUnsubscribeUrl } from "@/lib/email/unsubscribe";
import { emailLifecycleApiRequest, serverApiError } from "@/lib/server-api-client";

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
  row: OnboardingEmailClaimDto,
  config: Extract<OnboardingEmailConfig, { enabled: true }>,
) {
  const client = getResendClient(config.apiKey);
  const unsubscribeUrl = createGoatEmailUnsubscribeUrl({ email: row.email });
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

// Claims and sends every due onboarding email. Safe to call concurrently: the
// API claim uses SKIP LOCKED and each Resend send is idempotent.
export async function sweepDueOnboardingEmails({
  limit = 100,
}: {
  limit?: number;
} = {}): Promise<OnboardingEmailSweepResult> {
  const config = getOnboardingEmailConfig();
  if (!config.enabled) {
    logger.info("Skipped onboarding email sweep because Resend is not configured", {
      event: "opencompany.goat_onboarding_email_skipped",
      reason: config.reason,
    });
    return { status: "skipped", reason: config.reason };
  }

  const response = await emailLifecycleApiRequest("claim", { limit });
  if (!response.ok) throw await serverApiError(response, "Could not claim onboarding emails.");
  const envelope = OnboardingEmailClaimEnvelopeSchema.parse(await response.json()) as {
    data: { emails: OnboardingEmailClaimDto[] };
  };
  return deliverClaimedOnboardingEmails(envelope.data.emails, config);
}

// Enrolls a brand-new workspace owner into the sequence and fires the welcome
// email immediately. Best-effort: callers wrap this so a Resend/DB hiccup never
// blocks sign-in, and the hourly cron backstops both the welcome and the
// delayed steps.
export async function enrollOwnerInOnboardingEmails(user: { workosUserId: string }) {
  const response = await emailLifecycleApiRequest("enroll", {
    workosUserId: user.workosUserId,
  });
  if (!response.ok) {
    throw await serverApiError(response, "Could not enroll onboarding emails.");
  }
  const config = getOnboardingEmailConfig();
  if (!config.enabled) return;
  const claimed = await emailLifecycleApiRequest("claim", {
    limit: 4,
    workosUserId: user.workosUserId,
  });
  if (!claimed.ok) throw await serverApiError(claimed, "Could not claim the welcome email.");
  const envelope = OnboardingEmailClaimEnvelopeSchema.parse(await claimed.json()) as {
    data: { emails: OnboardingEmailClaimDto[] };
  };
  if (envelope.data.emails.some((row) => row.workosUserId !== user.workosUserId)) {
    throw new Error("The onboarding email claim did not match the caller.");
  }
  await deliverClaimedOnboardingEmails(envelope.data.emails, config);
}

async function deliverClaimedOnboardingEmails(
  claimed: OnboardingEmailClaimDto[],
  config: Extract<OnboardingEmailConfig, { enabled: true }>,
): Promise<OnboardingEmailSweepResult> {
  let sent = 0;
  let failed = 0;
  let rescheduled = 0;
  for (const row of claimed) {
    try {
      const result = await sendOnboardingEmail(row, config);
      await settleOnboardingEmail({ id: row.id, outcome: "sent" });
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
      if (row.terminalOnFailure) {
        await settleOnboardingEmail({ id: row.id, outcome: "failed", error: message });
        failed += 1;
      } else {
        await settleOnboardingEmail({
          id: row.id,
          outcome: "rescheduled",
          nextRunAt: new Date(Date.now() + backoffMs(row.attempts)),
          error: message,
        });
        rescheduled += 1;
      }
    }
  }
  return { status: "ok", claimed: claimed.length, sent, failed, rescheduled };
}

async function settleOnboardingEmail(input: {
  id: string;
  outcome: "sent" | "failed" | "rescheduled";
  error?: string;
  nextRunAt?: Date;
}) {
  const response = await emailLifecycleApiRequest("settle", {
    id: input.id,
    outcome: input.outcome,
    ...(input.error ? { error: input.error } : {}),
    ...(input.nextRunAt ? { nextRunAt: input.nextRunAt.toISOString() } : {}),
  });
  if (!response.ok) throw await serverApiError(response, "Could not settle onboarding email.");
}
