import { type ErrorResponse, Resend, type Response as ResendResponse } from "resend";

// Minimal typed wrapper around the Resend SDK, mirrored from apps/web/lib/email/client.ts.
// The app only sends transactional/lifecycle email (no contact/segment sync), so the surface
// used here is emails.send — the rest of the type is kept for parity with web.
export type ResendEmailClient = {
  emails: {
    send: (
      payload: {
        from: string;
        to: string;
        subject: string;
        html: string;
        text: string;
        replyTo: string;
        headers?: Record<string, string>;
        tags: Array<{ name: string; value: string }>;
      },
      options: { idempotencyKey: string },
    ) => Promise<ResendResponse<{ id: string }>>;
  };
};

let resendClient: ResendEmailClient | null = null;

export function trimmed(value: string | undefined) {
  const next = value?.trim();
  return next || undefined;
}

export function getResendClient(apiKey: string): ResendEmailClient {
  resendClient ??= new Resend(apiKey) as unknown as ResendEmailClient;
  return resendClient;
}

export function isResendNotFoundError(error: ErrorResponse) {
  return error.statusCode === 404 || error.name === "not_found";
}

export function assertResendResponse<T>(response: ResendResponse<T>, action: string): T {
  if (response.error) {
    throw new Error(`${action}: ${response.error.message}`);
  }

  return response.data;
}
