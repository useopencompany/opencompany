import { redirect } from "next/navigation";
import { describe, expect, it, vi } from "vitest";
import PersonalOnboardingLayout from "./layout";
import PersonalOnboardingPage from "./page";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

const redirectMock = vi.mocked(redirect);

describe("personal onboarding route gate", () => {
  it("redirects the old personal onboarding layout to the canonical onboarding flow", () => {
    expect(() => PersonalOnboardingLayout()).toThrow("redirect:/onboarding");

    expect(redirectMock).toHaveBeenCalledWith("/onboarding");
  });

  it("redirects the old personal onboarding page to the canonical onboarding flow", () => {
    expect(() => PersonalOnboardingPage()).toThrow("redirect:/onboarding");

    expect(redirectMock).toHaveBeenCalledWith("/onboarding");
  });
});
