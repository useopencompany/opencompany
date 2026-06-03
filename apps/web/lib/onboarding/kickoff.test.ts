import { describe, expect, it } from "vitest";
import { buildOnboardingKickoffPrompt } from "./kickoff";

describe("buildOnboardingKickoffPrompt", () => {
  it("reads as a warm first-person ask and includes the signup context", () => {
    const prompt = buildOnboardingKickoffPrompt({
      role: "Founder",
      teamSize: "2_10",
      companyUrl: "https://opencompany.ai/",
      helpAreas: ["product_building", "operations"],
    });

    expect(prompt).toContain("I just signed up");
    expect(prompt).toContain("set up OpenCompany");
    expect(prompt).toContain("My role: Founder");
    expect(prompt).toContain("Company: https://opencompany.ai/");
    // team size / help areas use human labels, not raw option values.
    expect(prompt).toContain("Team size: 2-10");
    expect(prompt).toContain("Building the product");
    expect(prompt).toContain("Operations");
    expect(prompt).not.toContain("product_building");
    expect(prompt).toContain("one focused set of setup questions");
    // With a company URL present, nudge leo to ground itself with a quick research pass.
    expect(prompt).toContain("take a quick look first");
  });

  it("joins multiple help areas with 'and'", () => {
    const prompt = buildOnboardingKickoffPrompt({
      role: "PM",
      teamSize: "1",
      companyUrl: null,
      helpAreas: ["decisions", "deep_research", "hiring"],
    });

    expect(prompt).toContain("Thinking through decisions, Deep web research, and Hiring");
  });

  it("omits the company line when no URL was provided", () => {
    const prompt = buildOnboardingKickoffPrompt({
      role: "Engineer",
      teamSize: "11_50",
      companyUrl: null,
      helpAreas: ["product_building"],
    });

    expect(prompt).not.toContain("Company:");
    expect(prompt).toContain("My role: Engineer");
    // No company URL means no research nudge.
    expect(prompt).not.toContain("take a quick look first");
  });
});
