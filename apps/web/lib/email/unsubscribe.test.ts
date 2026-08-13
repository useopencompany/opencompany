import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGoatEmailUnsubscribeToken,
  createGoatEmailUnsubscribeUrl,
  unsubscribeGoatOnboardingEmails,
  verifyGoatEmailUnsubscribeToken,
} from "@/lib/email/unsubscribe";
import { emailLifecycleApiRequest } from "@/lib/server-api-client";

vi.mock("@/lib/server-api-client", () => ({
  emailLifecycleApiRequest: vi.fn(),
  serverApiError: vi.fn(),
}));

vi.mock("@/lib/app-url", () => ({
  getGoatAppUrl: () => "https://goat.example.com",
}));

describe("goat onboarding unsubscribe tokens", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_secret";
  });

  afterEach(() => {
    process.env.RESEND_API_KEY = "";
  });

  it("round-trips a valid token (case-normalized email)", () => {
    const token = createGoatEmailUnsubscribeToken({ email: "Ada@Example.com" });
    const payload = verifyGoatEmailUnsubscribeToken(token);
    expect(payload).toEqual({ v: 1, type: "goat_onboarding", email: "ada@example.com" });
  });

  it("rejects a tampered signature", () => {
    const token = createGoatEmailUnsubscribeToken({ email: "ada@example.com" });
    const [payload] = token.split(".");
    expect(() => verifyGoatEmailUnsubscribeToken(`${payload}.deadbeef`)).toThrow(
      "Invalid unsubscribe token.",
    );
  });

  it("rejects a token signed with a different secret", () => {
    const token = createGoatEmailUnsubscribeToken({ email: "ada@example.com", secret: "other" });
    expect(() => verifyGoatEmailUnsubscribeToken(token)).toThrow("Invalid unsubscribe token.");
  });

  it("builds an unsubscribe url on the goat origin", () => {
    const url = new URL(createGoatEmailUnsubscribeUrl({ email: "ada@example.com" }));
    expect(url.origin).toBe("https://goat.example.com");
    expect(url.pathname).toBe("/api/email/unsubscribe");
    expect(verifyGoatEmailUnsubscribeToken(url.searchParams.get("token") ?? "").email).toBe(
      "ada@example.com",
    );
  });

  it("keeps token verification in web and sends only the verified email to the API", async () => {
    vi.mocked(emailLifecycleApiRequest).mockResolvedValueOnce(
      Response.json({ data: { skipped: 2 } }),
    );
    const token = createGoatEmailUnsubscribeToken({ email: "Ada@Example.com" });
    await expect(unsubscribeGoatOnboardingEmails({ token })).resolves.toEqual({
      status: "unsubscribed",
      email: "ada@example.com",
      skipped: 2,
    });
    expect(emailLifecycleApiRequest).toHaveBeenCalledWith("unsubscribe", {
      email: "ada@example.com",
    });
  });
});
