import { PROTOCOL_VERSION } from "@opencompany/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getResendClient } from "@/lib/email/client";
import { emailLifecycleApiRequest } from "@/lib/server-api-client";
import { enrollOwnerInOnboardingEmails, sweepDueOnboardingEmails } from "./onboarding-emails";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock("@/lib/email/client", () => ({
  assertResendResponse: vi.fn(() => ({ id: "email_1" })),
  getResendClient: vi.fn(() => ({ emails: { send: mocks.send } })),
  trimmed: (value: string | undefined) => value?.trim() || undefined,
}));

vi.mock("@/lib/email/unsubscribe", () => ({
  createEmailUnsubscribeUrl: vi.fn(() => "https://opencompany.example.test/api/email/unsubscribe"),
}));

vi.mock("@/lib/server-api-client", () => ({
  emailLifecycleApiRequest: vi.fn(),
  serverApiError: vi.fn(async (_response: Response, fallback: string) => new Error(fallback)),
}));

const claim = {
  id: "goem_1",
  workosUserId: "user_1",
  step: "welcome",
  attempts: 1,
  email: "owner@example.com",
  firstName: "Owner",
  terminalOnFailure: false,
};

function claimResponse() {
  return Response.json({
    data: { emails: [claim] },
    meta: { apiVersion: "v1", protocolVersion: PROTOCOL_VERSION },
  });
}

describe("web-owned onboarding email delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RESEND_API_KEY", "re_test_secret");
    mocks.send.mockResolvedValue({ data: { id: "email_1" }, error: null });
    vi.mocked(emailLifecycleApiRequest).mockImplementation(async (operation) =>
      operation === "claim" ? claimResponse() : Response.json({ data: { completed: true } }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("enrolls through the API, claims only the owner, and sends with Resend", async () => {
    await enrollOwnerInOnboardingEmails({ workosUserId: "user_1" });

    expect(emailLifecycleApiRequest).toHaveBeenNthCalledWith(1, "enroll", {
      workosUserId: "user_1",
    });
    expect(emailLifecycleApiRequest).toHaveBeenNthCalledWith(2, "claim", {
      limit: 4,
      workosUserId: "user_1",
    });
    expect(getResendClient).toHaveBeenCalledWith("re_test_secret");
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(emailLifecycleApiRequest).toHaveBeenNthCalledWith(3, "settle", {
      id: "goem_1",
      outcome: "sent",
    });
  });

  it("keeps the global cron sweep as a web sender over API-owned persistence", async () => {
    await expect(sweepDueOnboardingEmails({ limit: 100 })).resolves.toEqual({
      status: "ok",
      claimed: 1,
      sent: 1,
      failed: 0,
      rescheduled: 0,
    });
    expect(emailLifecycleApiRequest).toHaveBeenNthCalledWith(1, "claim", { limit: 100 });
    expect(emailLifecycleApiRequest).toHaveBeenNthCalledWith(2, "settle", {
      id: "goem_1",
      outcome: "sent",
    });
  });

  it("enrolls durably but does not claim when Resend is unavailable", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    await enrollOwnerInOnboardingEmails({ workosUserId: "user_1" });
    expect(emailLifecycleApiRequest).toHaveBeenCalledOnce();
    expect(emailLifecycleApiRequest).toHaveBeenCalledWith("enroll", {
      workosUserId: "user_1",
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
