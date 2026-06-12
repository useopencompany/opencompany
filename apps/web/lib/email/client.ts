import { type ErrorResponse, Resend, type Response as ResendResponse } from "resend";

export type ResendEmailClient = {
  contacts: {
    create: (payload: {
      email: string;
      firstName?: string;
      lastName?: string;
      unsubscribed?: boolean;
      segments?: { id: string }[];
    }) => Promise<ResendResponse<{ object: "contact"; id: string }>>;
    get: (payload: { email: string }) => Promise<
      ResendResponse<{
        object: "contact";
        id: string;
        email: string;
        first_name: string | null;
        last_name: string | null;
        unsubscribed: boolean;
        created_at: string;
        properties: Record<string, unknown>;
      }>
    >;
    update: (payload: {
      email: string;
      firstName?: string | null;
      lastName?: string | null;
      unsubscribed?: boolean;
    }) => Promise<ResendResponse<{ object: "contact"; id: string }>>;
    segments: {
      list: (payload: { email: string; limit?: number }) => Promise<
        ResendResponse<{
          object: "list";
          has_more: boolean;
          data: Array<{ id: string; name: string; created_at: string }>;
        }>
      >;
      add: (payload: {
        email: string;
        segmentId: string;
      }) => Promise<ResendResponse<{ id: string }>>;
    };
  };
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
  resendClient ??= new Resend(apiKey);
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
