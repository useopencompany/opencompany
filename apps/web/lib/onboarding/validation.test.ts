import { describe, expect, it } from "vitest";
import { type OnboardingValues, validateOnboardingValues } from "./validation";

const validValues: OnboardingValues = {
  heardFrom: "linkedin",
  heardFromDetail: "",
  role: "Founder",
  teamSize: "2_10",
  companyUrl: "opencompany.ai",
  agentExperience: "medium",
  helpAreas: ["product_building", "operations"],
};

describe("validateOnboardingValues", () => {
  it("normalizes valid onboarding values", () => {
    const result = validateOnboardingValues(validValues);

    expect(result.errors).toEqual({});
    expect(result.normalized.companyUrl).toBe("https://opencompany.ai/");
    expect(result.normalized.helpAreas).toEqual(["product_building", "operations"]);
  });

  it("reports missing required fields", () => {
    const result = validateOnboardingValues({
      heardFrom: "",
      heardFromDetail: "",
      role: "",
      teamSize: "",
      companyUrl: "",
      agentExperience: "",
      helpAreas: [],
    });

    expect(result.errors).toMatchObject({
      heardFrom: "Choose where you heard about opencompany.",
      role: "Enter your role.",
      teamSize: "Choose your team size.",
      agentExperience: "Choose your experience level.",
      helpAreas: "Choose at least one area.",
    });
  });

  it("requires details for the other source and filters unknown help areas", () => {
    const result = validateOnboardingValues({
      ...validValues,
      heardFrom: "other",
      heardFromDetail: "",
      companyUrl: "not-a-host",
      helpAreas: ["product_building", "unknown"],
    });

    expect(result.errors).toMatchObject({
      heardFromDetail: "Tell us where you heard about opencompany.",
      companyUrl: "Enter a valid company URL.",
    });
    expect(result.normalized.helpAreas).toEqual(["product_building"]);
  });
});
