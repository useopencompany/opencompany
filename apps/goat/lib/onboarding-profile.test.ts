import { ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS } from "@opencompany/goat-brain/schema";
import { describe, expect, it } from "vitest";
import {
  GOAT_ONBOARDING_BUILDING_MAX_LENGTH,
  goatOnboardingFoldersForRole,
  parseGoatOnboardingProfile,
} from "./onboarding-profile";

describe("goatOnboardingFoldersForRole", () => {
  it("returns independent role presets and falls back for unknown values", () => {
    const founderFolders = goatOnboardingFoldersForRole("founder");
    expect(founderFolders).toEqual([
      "thoughts",
      "projects",
      "product",
      "meetings",
      "decisions",
      "fundraising",
      "metrics",
    ]);
    founderFolders.pop();
    expect(goatOnboardingFoldersForRole("founder")).toHaveLength(7);
    expect(goatOnboardingFoldersForRole("unknown")).toEqual([
      ...ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS,
    ]);
  });
});

describe("parseGoatOnboardingProfile", () => {
  it("normalizes a supported role and optional building description", () => {
    expect(
      parseGoatOnboardingProfile({ role: "founder", building: "  A durable company  " }),
    ).toEqual({
      ok: true,
      role: "founder",
      building: "A durable company",
    });
    expect(parseGoatOnboardingProfile({ role: "research", building: "  " })).toEqual({
      ok: true,
      role: "research",
      building: null,
    });
  });

  it("rejects missing or unsupported roles", () => {
    expect(parseGoatOnboardingProfile({ role: null, building: null })).toEqual({
      ok: false,
      error: "Choose the role that best describes you.",
    });
    expect(parseGoatOnboardingProfile({ role: "administrator", building: null })).toEqual({
      ok: false,
      error: "Choose the role that best describes you.",
    });
  });

  it("rejects a non-text building description", () => {
    expect(parseGoatOnboardingProfile({ role: "founder", building: 123 })).toEqual({
      ok: false,
      error: "What you're building must be text.",
    });
  });

  it("rejects descriptions beyond the stored limit", () => {
    const result = parseGoatOnboardingProfile({
      role: "product",
      building: "x".repeat(GOAT_ONBOARDING_BUILDING_MAX_LENGTH + 1),
    });

    expect(result).toEqual({
      ok: false,
      error: `What you're building is too long (max ${GOAT_ONBOARDING_BUILDING_MAX_LENGTH} characters).`,
    });
  });
});
