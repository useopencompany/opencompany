import { agentExperienceValues, heardFromValues, teamSizeValues } from "@/lib/onboarding/options";
import type { PersonalIntegrationId } from "@/lib/personal/actions";
import { type PersonalBrainFolder, personalBrainFolderValues } from "@/lib/personal/brain-folders";
import { PERSONAL_INTEGRATIONS_CATALOG } from "@/lib/personal/integrations-catalog";

export const GOAL_MAX_LENGTH = 2000;

export type FieldErrors = Partial<
  Record<
    | "heardFrom"
    | "heardFromDetail"
    | "role"
    | "teamSize"
    | "companyUrl"
    | "agentExperience"
    | "goal"
    | "personalBrainFolders"
    | "personalIntegrations",
    string
  >
>;

export type OnboardingValues = {
  heardFrom: string;
  heardFromDetail: string;
  role: string;
  teamSize: string;
  companyUrl: string;
  agentExperience: string;
  goal: string;
  personalBrainFolders: string[];
  personalIntegrations: string[];
};

const personalIntegrationValues = PERSONAL_INTEGRATIONS_CATALOG.map((entry) => entry.id);

function isKnownValue(value: string, values: readonly string[]) {
  return values.includes(value);
}

export function normalizeCompanyUrl(value: string) {
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

export function validateOnboardingValues(values: OnboardingValues) {
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

  // The goal is optional — only guard against an unreasonably long answer.
  const goal = values.goal.trim();
  if (goal.length > GOAL_MAX_LENGTH) {
    errors.goal = `Keep your answer under ${GOAL_MAX_LENGTH} characters.`;
  }

  const personalBrainFolders = Array.from(new Set(values.personalBrainFolders));
  if (personalBrainFolders.some((folder) => !isKnownValue(folder, personalBrainFolderValues))) {
    errors.personalBrainFolders = "Choose only supported Personal Brain folders.";
  }

  const personalIntegrations = Array.from(new Set(values.personalIntegrations));
  if (
    personalIntegrations.some(
      (integration) => !isKnownValue(integration, personalIntegrationValues),
    )
  ) {
    errors.personalIntegrations = "Choose only supported integrations.";
  }

  return {
    errors,
    normalized: {
      companyUrl,
      goal: goal || null,
      personalBrainFolders: personalBrainFolders as PersonalBrainFolder[],
      personalIntegrations: personalIntegrations as PersonalIntegrationId[],
    },
  };
}
