import { describe, expect, it } from "vitest";
import { type OnboardingValues, validateOnboardingValues } from "./validation";

const validValues: OnboardingValues = {
  heardFrom: "linkedin",
  heardFromDetail: "",
  role: "Founder",
  teamSize: "2_10",
  companyUrl: "opencompany.ai",
  agentExperience: "medium",
  goal: "Win back my time",
  personalBrainFolders: ["meetings", "projects"],
  personalIntegrations: ["github", "gmail"],
};

describe("validateOnboardingValues", () => {
  it("normalizes valid onboarding values", () => {
    const result = validateOnboardingValues(validValues);

    expect(result.errors).toEqual({});
    expect(result.normalized.companyUrl).toBe("https://opencompany.ai/");
    expect(result.normalized.goal).toBe("Win back my time");
    expect(result.normalized.personalBrainFolders).toEqual(["meetings", "projects"]);
    expect(result.normalized.personalIntegrations).toEqual(["github", "gmail"]);
  });

  it("treats an empty goal as optional and normalizes it to null", () => {
    const result = validateOnboardingValues({ ...validValues, goal: "   " });

    expect(result.errors).toEqual({});
    expect(result.normalized.goal).toBeNull();
  });

  it("reports missing required fields", () => {
    const result = validateOnboardingValues({
      heardFrom: "",
      heardFromDetail: "",
      role: "",
      teamSize: "",
      companyUrl: "",
      agentExperience: "",
      goal: "",
      personalBrainFolders: [],
      personalIntegrations: [],
    });

    expect(result.errors).toMatchObject({
      heardFrom: "Choose where you heard about opencompany.",
      role: "Enter your role.",
      teamSize: "Choose your team size.",
      agentExperience: "Choose your experience level.",
    });
    expect(result.errors.goal).toBeUndefined();
  });

  it("requires details for the other source and validates the company URL", () => {
    const result = validateOnboardingValues({
      ...validValues,
      heardFrom: "other",
      heardFromDetail: "",
      companyUrl: "not-a-host",
    });

    expect(result.errors).toMatchObject({
      heardFromDetail: "Tell us where you heard about opencompany.",
      companyUrl: "Enter a valid company URL.",
    });
  });

  it("rejects unsupported Personal Brain folders", () => {
    const result = validateOnboardingValues({
      ...validValues,
      personalBrainFolders: ["meetings", "unknown"],
    });

    expect(result.errors.personalBrainFolders).toBe(
      "Choose only supported Personal Brain folders.",
    );
  });

  it("rejects unsupported integrations", () => {
    const result = validateOnboardingValues({
      ...validValues,
      personalIntegrations: ["github", "unknown"],
    });

    expect(result.errors.personalIntegrations).toBe("Choose only supported integrations.");
  });
});
