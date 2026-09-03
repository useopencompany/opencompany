import { describe, expect, it } from "vitest";
import { buildOnboardingKickoffPrompt } from "./onboarding-kickoff";

describe("buildOnboardingKickoffPrompt", () => {
  it("creates the transparent first Wiki-seeding run with the company URL", () => {
    const prompt = buildOnboardingKickoffPrompt("https://opencompany.ai/");

    expect(prompt).toContain("Keep this workflow in main chat");
    expect(prompt).toContain("Survey breadth before depth");
    expect(prompt).toContain("Read the existing Wiki tree");
    expect(prompt).not.toContain("save_to_brain");
    expect(prompt).toContain("Company: https://opencompany.ai/");
  });
});
