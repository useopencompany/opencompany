"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { captureServerEvent } from "@opencompany/analytics/server";
import { getCurrentWorkspaceWithoutOnboarding } from "@/lib/auth";
import { getDb } from "@opencompany/db/client";
import { onboardingResponses, workspaces } from "@opencompany/db/schema";
import {
  agentExperienceValues,
  heardFromValues,
  helpAreaValues,
  teamSizeValues,
} from "@/lib/onboarding/options";

type FieldErrors = Partial<
  Record<
    | "heardFrom"
    | "heardFromDetail"
    | "role"
    | "teamSize"
    | "companyUrl"
    | "agentExperience"
    | "helpAreas",
    string
  >
>;

type OnboardingValues = {
  heardFrom: string;
  heardFromDetail: string;
  role: string;
  teamSize: string;
  companyUrl: string;
  agentExperience: string;
  helpAreas: string[];
};

export type OnboardingActionState = {
  errors: FieldErrors;
  values: OnboardingValues;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function isKnownValue(value: string, values: readonly string[]) {
  return values.includes(value);
}

function normalizeCompanyUrl(value: string) {
  if (!value) return null;

  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;

  try {
    const url = new URL(withProtocol);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
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

  const errors: FieldErrors = {};

  if (!isKnownValue(values.heardFrom, heardFromValues)) {
    errors.heardFrom = "Choose where you heard about opencompany.";
  }

  if (values.heardFrom === "other" && !values.heardFromDetail) {
    errors.heardFromDetail = "Tell us where you heard about opencompany.";
  } else if (values.heardFromDetail.length > 160) {
    errors.heardFromDetail = "Keep the source under 160 characters.";
  }

  if (!values.role) {
    errors.role = "Enter your role.";
  } else if (values.role.length > 100) {
    errors.role = "Keep your role under 100 characters.";
  }

  if (!isKnownValue(values.teamSize, teamSizeValues)) {
    errors.teamSize = "Choose your team size.";
  }

  const companyUrl = normalizeCompanyUrl(values.companyUrl);
  if (values.companyUrl && !companyUrl) {
    errors.companyUrl = "Enter a valid company URL.";
  }

  if (!isKnownValue(values.agentExperience, agentExperienceValues)) {
    errors.agentExperience = "Choose your experience level.";
  }

  const helpAreas = values.helpAreas.filter((value) =>
    isKnownValue(value, helpAreaValues),
  );
  if (helpAreas.length === 0) {
    errors.helpAreas = "Choose at least one area.";
  }

  if (Object.keys(errors).length > 0) {
    return { errors, values };
  }

  const { user, workspace } = await getCurrentWorkspaceWithoutOnboarding();
  const db = getDb();
  const now = new Date();

  await db
    .update(workspaces)
    .set({
      teamSize: values.teamSize,
      companyUrl,
      updatedAt: now,
    })
    .where(eq(workspaces.id, workspace.id));

  await db
    .insert(onboardingResponses)
    .values({
      userId: user.id,
      workspaceId: workspace.id,
      heardFrom: values.heardFrom,
      heardFromDetail:
        values.heardFrom === "other" ? values.heardFromDetail : null,
      role: values.role,
      agentExperience: values.agentExperience,
      helpAreas,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: onboardingResponses.userId,
      set: {
        workspaceId: workspace.id,
        heardFrom: values.heardFrom,
        heardFromDetail:
          values.heardFrom === "other" ? values.heardFromDetail : null,
        role: values.role,
        agentExperience: values.agentExperience,
        helpAreas,
        updatedAt: now,
      },
    });

  await captureServerEvent("onboarding_completed", user.id, {
    user_id: user.id,
    workspace_id: workspace.id,
    heard_from: values.heardFrom,
    team_size: values.teamSize,
    agent_experience: values.agentExperience,
    help_areas: helpAreas,
    help_area_count: helpAreas.length,
  });

  redirect("/");
}
