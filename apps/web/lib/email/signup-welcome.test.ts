import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderSignupWelcomeEmail, sendSignupWelcomeEmail } from "./signup-welcome";

const originalEnv = { ...process.env };

function success<T>(data: T) {
  return { data, error: null, headers: null };
}

function error(name: string, message: string, statusCode: number | null = null) {
  return {
    data: null,
    error: { name, message, statusCode },
    headers: null,
  };
}

function createClientMock(input?: { contactExists?: boolean; segmentExists?: boolean }) {
  return {
    contacts: {
      create: vi.fn(async () => success({ object: "contact" as const, id: "ctc_123" })),
      get: vi.fn(async () =>
        input?.contactExists
          ? success({
              object: "contact" as const,
              id: "ctc_123",
              email: "ada@example.com",
              first_name: "Ada",
              last_name: "Lovelace",
              unsubscribed: true,
              created_at: "2026-01-01T00:00:00.000Z",
              properties: {},
            })
          : error("not_found", "Contact not found", 404),
      ),
      update: vi.fn(async () => success({ object: "contact" as const, id: "ctc_123" })),
      segments: {
        list: vi.fn(async () =>
          success({
            object: "list" as const,
            has_more: false,
            data: input?.segmentExists
              ? [{ id: "seg_registered", name: "Registered Users", created_at: "2026-01-01" }]
              : [],
          }),
        ),
        add: vi.fn(async () => success({ id: "seg_registered" })),
      },
    },
    emails: {
      send: vi.fn(async () => success({ id: "eml_123" })),
    },
  };
}

describe("renderSignupWelcomeEmail", () => {
  it("uses the first name when available", () => {
    const email = renderSignupWelcomeEmail({ firstName: "Ada" });

    expect(email.subject).toBe("Welcome to OpenCompany");
    expect(email.text).toContain("Hi Ada,");
    expect(email.html).toContain("<p>Hi Ada,</p>");
  });

  it("falls back to a neutral greeting", () => {
    const email = renderSignupWelcomeEmail({ firstName: "" });

    expect(email.text).toContain("Hi there,");
    expect(email.html).toContain("<p>Hi there,</p>");
  });
});

describe("sendSignupWelcomeEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_REGISTERED_USERS_SEGMENT_ID = "seg_registered";
    process.env.RESEND_WELCOME_FROM = "Louis from OpenCompany <louis@opencompany.cloud>";
    process.env.RESEND_REPLY_TO = "louis@opencompany.cloud";
  });

  it("creates a new contact and sends the welcome email", async () => {
    const client = createClientMock({ contactExists: false, segmentExists: true });

    const result = await sendSignupWelcomeEmail(
      {
        userId: "usr_123",
        workspaceId: "wks_123",
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
      },
      { client },
    );

    expect(result).toEqual({ status: "sent", emailId: "eml_123" });
    expect(client.contacts.create).toHaveBeenCalledWith({
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      unsubscribed: false,
      segments: [{ id: "seg_registered" }],
    });
    expect(client.contacts.update).not.toHaveBeenCalled();
    expect(client.contacts.segments.add).not.toHaveBeenCalled();
    expect(client.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Louis from OpenCompany <louis@opencompany.cloud>",
        to: "ada@example.com",
        subject: "Welcome to OpenCompany",
        replyTo: "louis@opencompany.cloud",
        text: expect.stringContaining("feedback you submit through the app"),
        html: expect.stringContaining("feedback you submit through the app"),
      }),
      { idempotencyKey: "signup-welcome:usr_123" },
    );
  });

  it("updates an existing contact without forcing a global resubscribe", async () => {
    const client = createClientMock({ contactExists: true, segmentExists: false });

    await sendSignupWelcomeEmail(
      {
        userId: "usr_123",
        workspaceId: "wks_123",
        email: "ada@example.com",
        firstName: "Ada",
        lastName: null,
      },
      { client },
    );

    expect(client.contacts.create).not.toHaveBeenCalled();
    expect(client.contacts.update).toHaveBeenCalledWith({
      email: "ada@example.com",
      firstName: "Ada",
      lastName: null,
    });
    expect(client.contacts.update.mock.calls[0]?.[0]).not.toHaveProperty("unsubscribed");
    expect(client.contacts.segments.add).toHaveBeenCalledWith({
      email: "ada@example.com",
      segmentId: "seg_registered",
    });
  });

  it("skips cleanly when Resend is not configured", async () => {
    process.env.RESEND_API_KEY = "";
    const client = createClientMock();

    const result = await sendSignupWelcomeEmail(
      {
        userId: "usr_123",
        workspaceId: "wks_123",
        email: "ada@example.com",
      },
      { client },
    );

    expect(result).toEqual({ status: "skipped", reason: "missing_api_key" });
    expect(client.contacts.get).not.toHaveBeenCalled();
    expect(client.emails.send).not.toHaveBeenCalled();
  });
});
