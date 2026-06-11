"use server";

import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { onboardingResponses, workspaces } from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { startSeededAgentSession } from "@/lib/agent-sessions/start-session";
import { currentWorkspace } from "@/lib/auth";
import { buildOnboardingKickoffPrompt } from "@/lib/onboarding/kickoff";
import { ensureUserOnboardingScaffold } from "@/lib/onboarding/scaffold";
import {
  type FieldErrors,
  type OnboardingValues,
  validateOnboardingValues,
} from "@/lib/onboarding/validation";
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
    helpAreas: formData
      .getAll("helpAreas")
      .filter((value): value is string => typeof value === "string"),
  };

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
      helpAreas: normalized.helpAreas,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: onboardingResponses.userId,
    })
    .returning({ userId: onboardingResponses.userId });

  if (!insertedOnboarding) {
    logger.info("Skipping duplicate onboarding completion", {
      event: "opencompany.onboarding_completion_duplicate",
      workspace_id: workspace.id,
      user_id: user.id,
    });
    redirect("/");
  }

  await db
    .update(workspaces)
    .set({
      teamSize: values.teamSize,
      companyUrl: normalized.companyUrl,
      updatedAt: now,
    })
    .where(eq(workspaces.id, workspace.id));

  const scaffold = await ensureUserOnboardingScaffold({
    userId: user.id,
    workspaceId: workspace.id,
  });

  logger.info("Resolved onboarding scaffold", {
    event: "opencompany.onboarding_scaffold_resolved",
    workspace_id: workspace.id,
    user_id: user.id,
    agent_id: scaffold.agentId,
    created: scaffold.created,
  });

  await captureServerEvent("onboarding_completed", user.id, {
    user_id: user.id,
    workspace_id: workspace.id,
    heard_from: values.heardFrom,
    team_size: values.teamSize,
    agent_experience: values.agentExperience,
    help_areas: normalized.helpAreas,
    help_area_count: normalized.helpAreas.length,
  });

  // On a user's very first onboarding, kick off their agent's first run seeded with a visible
  // message so they land directly in a live setup conversation. Skip when leo already exists
  // (re-submits) so we never spawn duplicate onboarding sessions.
  if (scaffold.created) {
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

    let sessionId: string | null = null;

    try {
      logger.info("Starting onboarding setup session", {
        event: "opencompany.onboarding_setup_session_starting",
        workspace_id: workspace.id,
        user_id: user.id,
        agent_id: scaffold.agentId,
      });
      sessionId = await startSeededAgentSession({
        agentId: scaffold.agentId,
        userId: user.id,
        workspaceId: workspace.id,
        prompt: buildOnboardingKickoffPrompt({
          role: values.role,
          teamSize: values.teamSize,
          companyUrl: normalized.companyUrl,
          helpAreas: normalized.helpAreas,
        }),
        source: "onboarding",
      });
    } catch (error) {
      captureException(error, {
        event: "opencompany.onboarding_seeded_session_start_failed",
        workspace_id: workspace.id,
        user_id: user.id,
        agent_id: scaffold.agentId,
      });
      logger.error("Failed to start onboarding seeded session", {
        event: "opencompany.onboarding_seeded_session_start_failed",
        workspace_id: workspace.id,
        user_id: user.id,
        agent_id: scaffold.agentId,
        ...errorLogFields(error),
      });
    }

    if (sessionId) {
      logger.info("Started onboarding setup session", {
        event: "opencompany.onboarding_setup_session_started",
        workspace_id: workspace.id,
        user_id: user.id,
        agent_id: scaffold.agentId,
        session_id: sessionId,
      });
      redirect(`/company/session/${sessionId}`);
    }

    logger.warn("Onboarding setup session was not created", {
      event: "opencompany.onboarding_setup_session_missing",
      workspace_id: workspace.id,
      user_id: user.id,
      agent_id: scaffold.agentId,
    });
  }

  redirect("/");
}
