import {
  type ClaimedGoatOnboardingEmail,
  claimDueGoatOnboardingEmails,
  enrollGoatOnboardingEmails,
  failGoatOnboardingEmail,
  MAX_GOAT_ONBOARDING_EMAIL_ATTEMPTS,
  markGoatOnboardingEmailSent,
  rescheduleGoatOnboardingEmail,
  skipPendingGoatOnboardingEmailsForEmail,
} from "@opencompany/db/goat-onboarding-emails";
import { listGoatWorkspacesForUser } from "@opencompany/db/goat-workspaces";
import { ApiError } from "./errors";

type DbLike = any;

export type OnboardingEmailClaimView = ClaimedGoatOnboardingEmail & {
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
    const rows = await claimDueGoatOnboardingEmails(
      { limit, ...(workosUserId ? { workosUserId } : {}) },
      { db },
    );
    return rows.map(onboardingEmailClaimView);
  }

  return {
    async enroll(workosUserId) {
      const workspaces = await listGoatWorkspacesForUser(workosUserId, { db });
      if (!workspaces.some(({ workspace }) => workspace.createdByWorkosId === workosUserId)) {
        throw new ApiError(
          403,
          "forbidden",
          "Only workspace owners receive owner onboarding emails.",
        );
      }
      await enrollGoatOnboardingEmails({ workosUserId }, { db });
    },

    claimDue(limit, workosUserId) {
      return claim(limit, workosUserId);
    },

    async settle(command) {
      if (command.outcome === "sent") {
        await markGoatOnboardingEmailSent(command.id, { db });
        return;
      }
      if (command.outcome === "failed") {
        await failGoatOnboardingEmail(
          { id: command.id, error: command.error ?? "Onboarding email delivery failed." },
          { db },
        );
        return;
      }
      if (!command.nextRunAt) throw new Error("A retry schedule is required.");
      await rescheduleGoatOnboardingEmail(
        {
          id: command.id,
          nextRunAt: command.nextRunAt,
          error: command.error ?? "Onboarding email delivery failed.",
        },
        { db },
      );
    },

    unsubscribe(email) {
      return skipPendingGoatOnboardingEmailsForEmail(email, { db });
    },
  };
}

function onboardingEmailClaimView(row: ClaimedGoatOnboardingEmail): OnboardingEmailClaimView {
  return {
    ...row,
    terminalOnFailure: row.attempts >= MAX_GOAT_ONBOARDING_EMAIL_ATTEMPTS,
  };
}
