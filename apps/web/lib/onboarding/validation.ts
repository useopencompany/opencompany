import {
  agentExperienceValues,
  heardFromValues,
  helpAreaValues,
  teamSizeValues,
} from "@/lib/onboarding/options";

export type FieldErrors = Partial<
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

export type OnboardingValues = {
  heardFrom: string;
  heardFromDetail: string;
  role: string;
  teamSize: string;
  companyUrl: string;
  agentExperience: string;
  helpAreas: string[];
};

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

  const helpAreas = values.helpAreas.filter((value) => isKnownValue(value, helpAreaValues));
  if (helpAreas.length === 0) {
    errors.helpAreas = "Choose at least one area.";
  }

  return {
    errors,
    normalized: {
      companyUrl,
      helpAreas,
    },
  };
}
