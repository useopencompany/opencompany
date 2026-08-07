import { ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS } from "@opencompany/brain/schema";
import { describe, expect, it } from "vitest";
import {
  GOAT_ONBOARDING_COMPANY_URL_MAX_LENGTH,
  goatOnboardingFoldersForRole,
  normalizeGoatOnboardingCompanyUrl,
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
  it.each([
    [" opencompany.ai ", "https://opencompany.ai/"],
    ["https:opencompany.ai/about", "https://opencompany.ai/about"],
    ["http://opencompany.ai", "http://opencompany.ai/"],
    ["https://opencompany.ai/company#team", "https://opencompany.ai/company"],
  ])("normalizes a supported role and company URL (%s)", (companyUrl, normalizedCompanyUrl) => {
    expect(parseGoatOnboardingProfile({ role: "founder", companyUrl })).toEqual({
      ok: true,
      role: "founder",
      companyUrl: normalizedCompanyUrl,
    });
  });

  it("accepts a well-formed URL without requiring the website to be reachable", () => {
    expect(
      parseGoatOnboardingProfile({
        role: "founder",
        companyUrl: "https://temporarily-unavailable.example",
      }),
    ).toEqual({
      ok: true,
      role: "founder",
      companyUrl: "https://temporarily-unavailable.example/",
    });
  });

  it("rejects missing or unsupported roles", () => {
    expect(
      parseGoatOnboardingProfile({ role: null, companyUrl: "https://opencompany.ai" }),
    ).toEqual({
      ok: false,
      error: "Choose the role that best describes you.",
    });
    expect(
      parseGoatOnboardingProfile({ role: "administrator", companyUrl: "https://opencompany.ai" }),
    ).toEqual({
      ok: false,
      error: "Choose the role that best describes you.",
    });
  });

  it("requires a valid company URL", () => {
    expect(parseGoatOnboardingProfile({ role: "founder", companyUrl: "  " })).toEqual({
      ok: false,
      error: "Enter your company URL.",
    });
    expect(
      parseGoatOnboardingProfile({ role: "founder", companyUrl: "mailto:team@example.com" }),
    ).toEqual({
      ok: false,
      error: "Enter a valid company URL.",
    });
  });

  it.each([
    "jamie",
    "https://localhost",
    "https://example.",
    "https://example.123",
  ])("rejects a value without a real domain (%s)", (companyUrl) => {
    expect(parseGoatOnboardingProfile({ role: "founder", companyUrl })).toEqual({
      ok: false,
      error: "Enter a valid company URL.",
    });
  });

  it("rejects credentials and values beyond the stored limit", () => {
    expect(normalizeGoatOnboardingCompanyUrl("https://user:secret@example.com")).toBeNull();
    expect(
      normalizeGoatOnboardingCompanyUrl(
        `https://example.com/${"x".repeat(GOAT_ONBOARDING_COMPANY_URL_MAX_LENGTH)}`,
      ),
    ).toBeNull();
  });
});
