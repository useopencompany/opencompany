import {
  type ClaimedOnboardingEmail,
  claimDueOnboardingEmails,
  enrollOnboardingEmails,
  failOnboardingEmail,
  MAX_ONBOARDING_EMAIL_ATTEMPTS,
  markOnboardingEmailSent,
  rescheduleOnboardingEmail,
  skipPendingOnboardingEmailsForEmail,
} from "@opencompany/db/onboarding-emails";
import { listWorkspacesForUser } from "@opencompany/db/workspaces";
import { ApiError } from "./errors";

type DbLike = any;

export type OnboardingEmailClaimView = ClaimedOnboardingEmail & {
  terminalOnFailure: boolean;
};

export type OnboardingEmailService = {
  enroll(workosUserId: string): Promise<void>;
  claimDue(limit: number, workosUserId?: string): Promise<OnboardingEmailClaimView[]>;
  settle(input: {
    id: string;
    outcome: "sent" | "failed" | "rescheduled";
    error?: string;
    nextRunAt?: Date;
  }): Promise<void>;
  unsubscribe(email: string): Promise<number>;
};

export function createOnboardingEmailService(input: { db: DbLike }): OnboardingEmailService {
  const { db } = input;

  async function claim(limit: number, workosUserId?: string) {
    const rows = await claimDueOnboardingEmails(
      { limit, ...(workosUserId ? { workosUserId } : {}) },
      { db },
    );
    return rows.map(onboardingEmailClaimView);
  }

  return {
    async enroll(workosUserId) {
      const workspaces = await listWorkspacesForUser(workosUserId, { db });
      if (!workspaces.some(({ workspace }) => workspace.createdByWorkosId === workosUserId)) {
        throw new ApiError(
          403,
          "forbidden",
          "Only workspace owners receive owner onboarding emails.",
        );
      }
      await enrollOnboardingEmails({ workosUserId }, { db });
    },

    claimDue(limit, workosUserId) {
      return claim(limit, workosUserId);
    },

    async settle(command) {
      if (command.outcome === "sent") {
        await markOnboardingEmailSent(command.id, { db });
        return;
      }
      if (command.outcome === "failed") {
        await failOnboardingEmail(
          { id: command.id, error: command.error ?? "Onboarding email delivery failed." },
          { db },
        );
        return;
      }
      if (!command.nextRunAt) throw new Error("A retry schedule is required.");
      await rescheduleOnboardingEmail(
        {
          id: command.id,
          nextRunAt: command.nextRunAt,
          error: command.error ?? "Onboarding email delivery failed.",
        },
        { db },
      );
    },

    unsubscribe(email) {
      return skipPendingOnboardingEmailsForEmail(email, { db });
    },
  };
}

function onboardingEmailClaimView(row: ClaimedOnboardingEmail): OnboardingEmailClaimView {
  return {
    ...row,
    terminalOnFailure: row.attempts >= MAX_ONBOARDING_EMAIL_ATTEMPTS,
  };
}
