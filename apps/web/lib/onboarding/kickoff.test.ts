import { describe, expect, it } from "vitest";
import { buildOnboardingKickoffPrompt } from "./kickoff";

describe("buildOnboardingKickoffPrompt", () => {
  it("reads as a warm first-person ask and includes the signup context", () => {
    const prompt = buildOnboardingKickoffPrompt({
      role: "Founder",
      teamSize: "2_10",
      companyUrl: "https://opencompany.ai/",
      goal: "Win back my time and stay on top of customers",
    });

    expect(prompt).toContain("I just signed up");
    expect(prompt).toContain("set up OpenCompany");
    expect(prompt).toContain("My role: Founder");
    expect(prompt).toContain("Company: https://opencompany.ai/");
    // team size uses a human label, not the raw option value.
    expect(prompt).toContain("Team size: 2-10");
    expect(prompt).toContain(
      "What I want to accomplish: Win back my time and stay on top of customers",
    );
    expect(prompt).toContain("one focused set of setup questions");
    // With a company URL present, nudge leo to ground itself with a quick research pass.
    expect(prompt).toContain("take a quick look first");
  });

  it("omits the goal line when none was provided", () => {
    const prompt = buildOnboardingKickoffPrompt({
      role: "PM",
      teamSize: "1",
      companyUrl: null,
      goal: null,
    });

    expect(prompt).not.toContain("What I want to accomplish");
    expect(prompt).toContain("My role: PM");
  });

  it("omits the company line when no URL was provided", () => {
    const prompt = buildOnboardingKickoffPrompt({
      role: "Engineer",
      teamSize: "11_50",
      companyUrl: null,
      goal: null,
    });

    expect(prompt).not.toContain("Company:");
    expect(prompt).toContain("My role: Engineer");
    // No company URL means no research nudge.
    expect(prompt).not.toContain("take a quick look first");
  });
});
