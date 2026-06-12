"use server";

import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { onboardingResponses, workspaces } from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { createPersonalOnboardingSession } from "@/lib/agent-sessions/actions";
import { currentWorkspace } from "@/lib/auth";
import { ONBOARDING_FIRST_SESSION_PROMPT } from "@/lib/onboarding/first-session";
import {
  type FieldErrors,
  type OnboardingValues,
  validateOnboardingValues,
} from "@/lib/onboarding/validation";
import { personalPaths } from "@/lib/personal/paths";
import { ensurePersonalAgent } from "@/lib/personal/scaffold";
import { dispatchSlackSupportChannelRequested } from "@/lib/slack/events";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

export type OnboardingActionState = {
  errors: FieldErrors;
  values: OnboardingValues;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readStringList(formData: FormData, key: string) {
  return formData
    .getAll(key)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

function errorLogFields(error: unknown) {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
    };
  }

  return {
    error_name: typeof error,
    error_message: typeof error === "string" ? error : "Unknown error",
  };
}

export async function completeOnboarding(
  _previousState: OnboardingActionState,
  formData: FormData,
): Promise<OnboardingActionState> {
  const values: OnboardingValues = {
    heardFrom: readString(formData, "heardFrom"),
    heardFromDetail: readString(formData, "heardFromDetail"),
    role: readString(formData, "role"),
    teamSize: readString(formData, "teamSize"),
    companyUrl: readString(formData, "companyUrl"),
    agentExperience: readString(formData, "agentExperience"),
    goal: readString(formData, "goal"),
    personalBrainFolders: readStringList(formData, "personalBrainFolders"),
    personalIntegrations: readStringList(formData, "personalIntegrations"),
  };
  const forceOnboarding = readString(formData, "forceOnboarding") === "1";

  const { errors, normalized } = validateOnboardingValues(values);

  if (Object.keys(errors).length > 0) {
    return { errors, values };
  }

  const { user, workspace } = await currentWorkspace({ skipOnboarding: true });
  const db = getDb();
  const now = new Date();

  logger.info("Completing onboarding", {
    event: "opencompany.onboarding_completion_requested",
    workspace_id: workspace.id,
    user_id: user.id,
  });

  const [insertedOnboarding] = await db
    .insert(onboardingResponses)
    .values({
      userId: user.id,
      workspaceId: workspace.id,
      heardFrom: values.heardFrom,
      heardFromDetail: values.heardFrom === "other" ? values.heardFromDetail : null,
      role: values.role,
      agentExperience: values.agentExperience,
      goal: normalized.goal,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: onboardingResponses.userId,
    })
    .returning({ userId: onboardingResponses.userId });

  if (!insertedOnboarding && !forceOnboarding) {
    logger.info("Skipping duplicate onboarding completion", {
      event: "opencompany.onboarding_completion_duplicate",
      workspace_id: workspace.id,
      user_id: user.id,
    });
    redirect("/");
  }

  if (!insertedOnboarding) {
    logger.info("Retrying duplicate onboarding completion", {
      event: "opencompany.onboarding_completion_duplicate_retry",
      workspace_id: workspace.id,
      user_id: user.id,
    });
  }

  await db
    .update(workspaces)
    .set({
      teamSize: values.teamSize,
      companyUrl: normalized.companyUrl,
      updatedAt: now,
    })
    .where(eq(workspaces.id, workspace.id));

  const personalAgent = await ensurePersonalAgent({
    userId: user.id,
    workspaceId: workspace.id,
    userName: user.firstName?.trim() || user.email?.split("@")[0] || "you",
    personalBrainFolders: normalized.personalBrainFolders,
  });

  await captureServerEvent("onboarding_completed", user.id, {
    user_id: user.id,
    workspace_id: workspace.id,
    heard_from: values.heardFrom,
    team_size: values.teamSize,
    agent_experience: values.agentExperience,
    goal_provided: Boolean(normalized.goal),
  });

  // First onboarding only: kick off Slack Connect support-channel provisioning.
  // Fire-and-forget — Slack must never block or crash onboarding, and the
  // Inngest function is idempotent per workspace.
  try {
    await dispatchSlackSupportChannelRequested({
      workspaceId: workspace.id,
      userId: user.id,
      customerEmail: user.email,
      firstName: user.firstName,
    });
  } catch (error) {
    captureException(error, {
      event: "opencompany.slack_support_dispatch_failed",
      workspace_id: workspace.id,
      user_id: user.id,
    });
    logger.error("Failed to dispatch Slack support provisioning", {
      event: "opencompany.slack_support_dispatch_failed",
      workspace_id: workspace.id,
      user_id: user.id,
      ...errorLogFields(error),
    });
  }

  let firstSessionResult: Awaited<ReturnType<typeof createPersonalOnboardingSession>> | null = null;

  try {
    logger.info("Starting onboarding first session", {
      event: "opencompany.onboarding_first_session_starting",
      workspace_id: workspace.id,
      user_id: user.id,
      agent_id: personalAgent.id,
    });

    firstSessionResult = await createPersonalOnboardingSession(
      personalAgent.id,
      {
        name: user.firstName?.trim() || user.email?.split("@")[0] || "",
        website: normalized.companyUrl ?? "",
        role: values.role,
        teamSize: values.teamSize,
        agentExperience: values.agentExperience,
      },
      ONBOARDING_FIRST_SESSION_PROMPT,
      {
        integrations: normalized.personalIntegrations,
        skipBillingCheck: true,
        survey: {
          heardFrom: values.heardFrom,
          heardFromDetail: values.heardFromDetail,
        },
      },
    );
  } catch (error) {
    captureException(error, {
      event: "opencompany.onboarding_first_session_start_failed",
      workspace_id: workspace.id,
      user_id: user.id,
      agent_id: personalAgent.id,
    });
    logger.error("Failed to start onboarding first session", {
      event: "opencompany.onboarding_first_session_start_failed",
      workspace_id: workspace.id,
      user_id: user.id,
      agent_id: personalAgent.id,
      ...errorLogFields(error),
    });
  }

  if (firstSessionResult?.ok) {
    logger.info("Started onboarding first session", {
      event: "opencompany.onboarding_first_session_started",
      workspace_id: workspace.id,
      user_id: user.id,
      agent_id: personalAgent.id,
      session_id: firstSessionResult.session.id,
    });
    redirect(personalPaths.session(firstSessionResult.session.id));
  }

  if (firstSessionResult && !firstSessionResult.ok) {
    if (firstSessionResult.redirectTo) {
      redirect(firstSessionResult.redirectTo);
    }

    logger.warn("Onboarding first session was not created", {
      event: "opencompany.onboarding_first_session_missing",
      workspace_id: workspace.id,
      user_id: user.id,
      agent_id: personalAgent.id,
      error: firstSessionResult.error,
    });
  }

  redirect("/");
}
