import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlackInviteEmail, sendSlackInviteEmail } from "./slack-invite";

const originalEnv = { ...process.env };

// This suite reassigns process.env per test; restore it afterward so the mutated
// env never leaks into other test files sharing the worker.
afterAll(() => {
  process.env = { ...originalEnv };
});

function success<T>(data: T) {
  return { data, error: null, headers: null };
}

function createClientMock() {
  return {
    emails: {
      send: vi.fn(async () => success({ id: "eml_slack_123" })),
    },
  };
}

const baseInput = {
  userId: "usr_123",
  workspaceId: "wks_123",
  email: "customer@acme.com",
  firstName: "Sam",
};

describe("renderSlackInviteEmail", () => {
  it("greets by first name and links the invite url", () => {
    const email = renderSlackInviteEmail({
      firstName: "Sam",
      inviteUrl: "https://join.slack.com/share/abc",
    });

    expect(email.subject).toBe("Connect with our team on Slack");
    expect(email.text).toContain("Hi Sam,");
    expect(email.text).toContain("https://join.slack.com/share/abc");
    expect(email.html).toContain("Hi Sam,");
    expect(email.html).toContain('href="https://join.slack.com/share/abc"');
    expect(email.html).toContain("Connect on Slack");
  });

  it("falls back to a neutral greeting without a name", () => {
    const email = renderSlackInviteEmail({ firstName: "", inviteUrl: "https://x" });

    expect(email.text).toContain("Hi there,");
    expect(email.html).toContain("Hi there,");
  });

  it("escapes html in the invite url", () => {
    const email = renderSlackInviteEmail({
      firstName: "Sam",
      inviteUrl: 'https://x?a=1&b="2"',
    });

    expect(email.html).toContain("https://x?a=1&amp;b=&quot;2&quot;");
  });
});

describe("sendSlackInviteEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_WELCOME_FROM = "Louis from OpenCompany <louis@opencompany.cloud>";
    process.env.RESEND_REPLY_TO = "louis@opencompany.cloud";
  });

  it("sends the invite email with a per-workspace idempotency key", async () => {
    const client = createClientMock();

    const result = await sendSlackInviteEmail(
      { ...baseInput, inviteUrl: "https://join.slack.com/share/abc" },
      { client },
    );

    expect(result).toEqual({ status: "sent", emailId: "eml_slack_123" });
    expect(client.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Louis from OpenCompany <louis@opencompany.cloud>",
        to: "customer@acme.com",
        subject: "Connect with our team on Slack",
        replyTo: "louis@opencompany.cloud",
        tags: [
          { name: "category", value: "transactional" },
          { name: "type", value: "slack_invite" },
        ],
      }),
      { idempotencyKey: "slack-invite:wks_123" },
    );
  });

  it("skips when the invite url is empty (no dead link)", async () => {
    const client = createClientMock();

    const result = await sendSlackInviteEmail({ ...baseInput, inviteUrl: "" }, { client });

    expect(result).toEqual({ status: "skipped", reason: "no_invite_url" });
    expect(client.emails.send).not.toHaveBeenCalled();
  });

  it("skips when Resend is not configured", async () => {
    process.env.RESEND_API_KEY = "";
    const client = createClientMock();

    const result = await sendSlackInviteEmail(
      { ...baseInput, inviteUrl: "https://join.slack.com/share/abc" },
      { client },
    );

    expect(result).toEqual({ status: "skipped", reason: "missing_api_key" });
    expect(client.emails.send).not.toHaveBeenCalled();
  });

  it("throws when Resend returns an error", async () => {
    const client = {
      emails: {
        send: vi.fn(async () => ({
          data: null,
          error: { name: "rate_limited", message: "slow down", statusCode: 429 },
          headers: null,
        })),
      },
    };

    await expect(
      sendSlackInviteEmail(
        { ...baseInput, inviteUrl: "https://join.slack.com/share/abc" },
        { client },
      ),
    ).rejects.toThrow("Unable to send Slack invite email: slow down");
  });
});
