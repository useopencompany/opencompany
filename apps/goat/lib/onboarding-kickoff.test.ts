import { describe, expect, it } from "vitest";
import { buildGoatOnboardingKickoffPrompt } from "./onboarding-kickoff";

describe("buildGoatOnboardingKickoffPrompt", () => {
  it("creates the transparent first Brain-seeding run with the company URL", () => {
    const prompt = buildGoatOnboardingKickoffPrompt("https://opencompany.ai/");

    expect(prompt).toContain("Keep this workflow in main chat");
    expect(prompt).toContain("Survey breadth before depth");
    expect(prompt).toContain("call save_to_brain");
    expect(prompt).toContain("Company: https://opencompany.ai/");
  });
});
