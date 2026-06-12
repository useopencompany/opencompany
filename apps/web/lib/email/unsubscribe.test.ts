import { describe, expect, it, vi } from "vitest";
import {
  createEmailUnsubscribeToken,
  createEmailUnsubscribeUrl,
  unsubscribeResendContact,
  verifyEmailUnsubscribeToken,
} from "./unsubscribe";

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

function createClientMock(input?: { updateNotFound?: boolean }) {
  return {
    contacts: {
      create: vi.fn(async () => success({ object: "contact" as const, id: "ctc_created" })),
      get: vi.fn(),
      update: vi.fn(async () =>
        input?.updateNotFound
          ? error("not_found", "Contact not found", 404)
          : success({ object: "contact" as const, id: "ctc_updated" }),
      ),
      segments: {
        list: vi.fn(),
        add: vi.fn(),
      },
    },
    emails: {
      send: vi.fn(),
    },
  };
}

describe("email unsubscribe tokens", () => {
  it("round-trips a signed unsubscribe token", () => {
    const token = createEmailUnsubscribeToken({
      email: "Ada@Example.com",
      type: "signup_welcome",
      secret: "test-secret",
    });

    expect(verifyEmailUnsubscribeToken(token, "test-secret")).toEqual({
      v: 1,
      email: "ada@example.com",
      type: "signup_welcome",
    });
  });

  it("rejects tampered tokens", () => {
    const token = createEmailUnsubscribeToken({
      email: "ada@example.com",
      type: "signup_welcome",
      secret: "test-secret",
    });

    expect(() => verifyEmailUnsubscribeToken(`${token}x`, "test-secret")).toThrow(
      "Invalid unsubscribe token.",
    );
  });

  it("builds an app unsubscribe URL", () => {
    const url = new URL(
      createEmailUnsubscribeUrl({
        email: "ada@example.com",
        type: "signup_welcome",
        baseUrl: "https://app.opencompany.cloud",
        secret: "test-secret",
      }),
    );

    expect(url.origin).toBe("https://app.opencompany.cloud");
    expect(url.pathname).toBe("/api/email/unsubscribe");
    expect(url.searchParams.get("token")).toBeTruthy();
  });
});

describe("unsubscribeResendContact", () => {
  it("marks an existing Resend contact as globally unsubscribed", async () => {
    const client = createClientMock();
    const token = createEmailUnsubscribeToken({
      email: "ada@example.com",
      type: "signup_welcome",
      secret: "re_test",
    });
    vi.stubEnv("RESEND_API_KEY", "re_test");

    const result = await unsubscribeResendContact({ token, client });

    expect(result).toEqual({
      status: "unsubscribed",
      email: "ada@example.com",
      contactId: "ctc_updated",
    });
    expect(client.contacts.update).toHaveBeenCalledWith({
      email: "ada@example.com",
      unsubscribed: true,
    });
    expect(client.contacts.create).not.toHaveBeenCalled();
  });

  it("creates an unsubscribed contact if one does not exist yet", async () => {
    const client = createClientMock({ updateNotFound: true });
    const token = createEmailUnsubscribeToken({
      email: "ada@example.com",
      type: "signup_welcome",
      secret: "re_test",
    });
    vi.stubEnv("RESEND_API_KEY", "re_test");

    const result = await unsubscribeResendContact({ token, client });

    expect(result.contactId).toBe("ctc_created");
    expect(client.contacts.create).toHaveBeenCalledWith({
      email: "ada@example.com",
      unsubscribed: true,
    });
  });
});
