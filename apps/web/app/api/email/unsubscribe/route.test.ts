import { captureException } from "@opencompany/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmailUnsubscribeToken, unsubscribeResendContact } from "@/lib/email/unsubscribe";
import { GET, POST } from "./route";

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
}));

vi.mock("@/lib/email/unsubscribe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/unsubscribe")>();
  return {
    ...actual,
    unsubscribeResendContact: vi.fn(),
  };
});

const captureExceptionMock = vi.mocked(captureException);
const unsubscribeResendContactMock = vi.mocked(unsubscribeResendContact);

function request(method: string, token: string) {
  return new Request(`https://app.opencompany.cloud/api/email/unsubscribe?token=${token}`, {
    method,
  });
}

describe("email unsubscribe route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RESEND_API_KEY", "re_test");
    unsubscribeResendContactMock.mockResolvedValue({
      status: "unsubscribed",
      email: "ada@example.com",
      contactId: "ctc_123",
    });
  });

  it("handles regular GET unsubscribe links with a confirmation page", async () => {
    const token = createEmailUnsubscribeToken({
      email: "ada@example.com",
      type: "signup_welcome",
      secret: "re_test",
    });

    const response = await GET(request("GET", token));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("You're unsubscribed");
    expect(unsubscribeResendContactMock).toHaveBeenCalledWith({ token });
  });

  it("handles RFC 8058 one-click POST with an empty success response", async () => {
    const token = createEmailUnsubscribeToken({
      email: "ada@example.com",
      type: "signup_welcome",
      secret: "re_test",
    });

    const response = await POST(request("POST", token));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("");
    expect(unsubscribeResendContactMock).toHaveBeenCalledWith({ token });
  });

  it("rejects invalid POST tokens without calling Resend", async () => {
    const response = await POST(request("POST", "bad-token"));

    expect(response.status).toBe(400);
    expect(unsubscribeResendContactMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalled();
  });
});
