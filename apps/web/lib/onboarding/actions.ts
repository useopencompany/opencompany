"use server";

import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { onboardingResponses, workspaces } from "@opencompany/db/schema";
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

export type OnboardingActionState = {
  errors: FieldErrors;
  values: OnboardingValues;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
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

  await db
    .update(workspaces)
    .set({
      teamSize: values.teamSize,
      companyUrl: normalized.companyUrl,
      updatedAt: now,
    })
    .where(eq(workspaces.id, workspace.id));

  await db
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
    .onConflictDoUpdate({
      target: onboardingResponses.userId,
      set: {
        workspaceId: workspace.id,
        heardFrom: values.heardFrom,
        heardFromDetail: values.heardFrom === "other" ? values.heardFromDetail : null,
        role: values.role,
        agentExperience: values.agentExperience,
        helpAreas: normalized.helpAreas,
        updatedAt: now,
      },
    });

  const scaffold = await ensureUserOnboardingScaffold({
    userId: user.id,
    workspaceId: workspace.id,
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
    const sessionId = await startSeededAgentSession({
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

    if (sessionId) {
      redirect(`/session/${sessionId}`);
    }
  }

  redirect("/");
}
