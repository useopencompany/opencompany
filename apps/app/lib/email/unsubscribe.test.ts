import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmailUnsubscribeToken,
  createEmailUnsubscribeUrl,
  verifyEmailUnsubscribeToken,
} from "@/lib/email/unsubscribe";

vi.mock("@opencompany/db/onboarding-emails", () => ({
  skipPendingOnboardingEmailsForEmail: vi.fn(),
}));

vi.mock("@/lib/app-url", () => ({
  getAppUrl: () => "https://app.example.com",
}));

describe("goat onboarding unsubscribe tokens", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_secret";
  });

  afterEach(() => {
    process.env.RESEND_API_KEY = "";
  });

  it("round-trips a valid token (case-normalized email)", () => {
    const token = createEmailUnsubscribeToken({ email: "Ada@Example.com" });
    const payload = verifyEmailUnsubscribeToken(token);
    expect(payload).toEqual({ v: 1, type: "goat_onboarding", email: "ada@example.com" });
  });

  it("rejects a tampered signature", () => {
    const token = createEmailUnsubscribeToken({ email: "ada@example.com" });
    const [payload] = token.split(".");
    expect(() => verifyEmailUnsubscribeToken(`${payload}.deadbeef`)).toThrow(
      "Invalid unsubscribe token.",
    );
  });

  it("rejects a token signed with a different secret", () => {
    const token = createEmailUnsubscribeToken({ email: "ada@example.com", secret: "other" });
    expect(() => verifyEmailUnsubscribeToken(token)).toThrow("Invalid unsubscribe token.");
  });

  it("builds an unsubscribe url on the goat origin", () => {
    const url = new URL(createEmailUnsubscribeUrl({ email: "ada@example.com" }));
    expect(url.origin).toBe("https://app.example.com");
    expect(url.pathname).toBe("/api/email/unsubscribe");
    expect(verifyEmailUnsubscribeToken(url.searchParams.get("token") ?? "").email).toBe(
      "ada@example.com",
    );
  });
});
