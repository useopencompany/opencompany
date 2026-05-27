import { captureException, createLogger } from "@opencompany/observability";
import { type ErrorResponse, Resend, type Response as ResendResponse } from "resend";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

const DEFAULT_WELCOME_FROM = "Louis from OpenCompany <louis@opencompany.cloud>";
const DEFAULT_REPLY_TO = "louis@opencompany.cloud";
const SIGNUP_WELCOME_SUBJECT = "Welcome to OpenCompany";

export type SignupWelcomeEmailInput = {
  userId: string;
  workspaceId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
};

type ResendEmailClient = {
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
        tags: Array<{ name: string; value: string }>;
      },
      options: { idempotencyKey: string },
    ) => Promise<ResendResponse<{ id: string }>>;
  };
};

type SignupWelcomeEmailConfig =
  | {
      enabled: true;
      apiKey: string;
      from: string;
      replyTo: string;
      registeredUsersSegmentId: string;
    }
  | {
      enabled: false;
      reason: "missing_api_key";
    };

let resendClient: ResendEmailClient | null = null;

function trimmed(value: string | undefined) {
  const next = value?.trim();
  return next || undefined;
}

function normalizeName(value: string | null | undefined) {
  return trimmed(value ?? undefined);
}

function getSignupWelcomeEmailConfig(): SignupWelcomeEmailConfig {
  const apiKey = trimmed(process.env.RESEND_API_KEY);

  if (!apiKey) {
    return { enabled: false, reason: "missing_api_key" };
  }

  const registeredUsersSegmentId = trimmed(process.env.RESEND_REGISTERED_USERS_SEGMENT_ID);

  if (!registeredUsersSegmentId) {
    throw new Error("RESEND_REGISTERED_USERS_SEGMENT_ID is required when RESEND_API_KEY is set.");
  }

  return {
    enabled: true,
    apiKey,
    from: trimmed(process.env.RESEND_WELCOME_FROM) ?? DEFAULT_WELCOME_FROM,
    replyTo: trimmed(process.env.RESEND_REPLY_TO) ?? DEFAULT_REPLY_TO,
    registeredUsersSegmentId,
  };
}

function getResendClient(apiKey: string): ResendEmailClient {
  resendClient ??= new Resend(apiKey);
  return resendClient;
}

function isNotFoundError(error: ErrorResponse) {
  return error.statusCode === 404 || error.name === "not_found";
}

function assertResendResponse<T>(response: ResendResponse<T>, action: string): T {
  if (response.error) {
    throw new Error(`${action}: ${response.error.message}`);
  }

  return response.data;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderSignupWelcomeEmail(input: { firstName?: string | null | undefined }) {
  const greetingName = normalizeName(input.firstName) ?? "there";
  const greeting = `Hi ${greetingName},`;

  const text = [
    greeting,
    "",
    "Thanks for signing up for OpenCompany.",
    "",
    "I wanted to send a quick personal note: every piece of feedback you submit through the app goes straight to me, and I will move fast on it.",
    "",
    "You can also just reply to this email any time.",
    "",
    "Louis",
  ].join("\n");

  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<body>",
    `<p>${escapeHtml(greeting)}</p>`,
    "<p>Thanks for signing up for OpenCompany.</p>",
    "<p>I wanted to send a quick personal note: every piece of feedback you submit through the app goes straight to me, and I will move fast on it.</p>",
    "<p>You can also just reply to this email any time.</p>",
    "<p>Louis</p>",
    "</body>",
    "</html>",
  ].join("");

  return {
    subject: SIGNUP_WELCOME_SUBJECT,
    text,
    html,
  };
}

async function loadContact(client: ResendEmailClient, email: string) {
  const response = await client.contacts.get({ email });

  if (response.error) {
    if (isNotFoundError(response.error)) return null;
    throw new Error(`Unable to load Resend contact: ${response.error.message}`);
  }

  return response.data;
}

async function syncRegisteredUserContact(input: {
  client: ResendEmailClient;
  email: string;
  firstName?: string;
  lastName?: string;
  registeredUsersSegmentId: string;
}) {
  const contact = await loadContact(input.client, input.email);

  if (contact) {
    assertResendResponse(
      await input.client.contacts.update({
        email: input.email,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
      }),
      "Unable to update Resend contact",
    );
  } else {
    assertResendResponse(
      await input.client.contacts.create({
        email: input.email,
        unsubscribed: false,
        segments: [{ id: input.registeredUsersSegmentId }],
        ...(input.firstName ? { firstName: input.firstName } : {}),
        ...(input.lastName ? { lastName: input.lastName } : {}),
      }),
      "Unable to create Resend contact",
    );
  }

  const segments = assertResendResponse(
    await input.client.contacts.segments.list({ email: input.email, limit: 100 }),
    "Unable to list Resend contact segments",
  );

  if (segments.data.some((segment) => segment.id === input.registeredUsersSegmentId)) {
    return;
  }

  assertResendResponse(
    await input.client.contacts.segments.add({
      email: input.email,
      segmentId: input.registeredUsersSegmentId,
    }),
    "Unable to add Resend contact to Registered Users segment",
  );
}

export async function sendSignupWelcomeEmail(
  input: SignupWelcomeEmailInput,
  options?: { client?: ResendEmailClient },
) {
  const config = getSignupWelcomeEmailConfig();

  if (!config.enabled) {
    logger.info("Skipped signup welcome email because Resend is not configured", {
      event: "opencompany.signup_welcome_email_skipped",
      user_id: input.userId,
      workspace_id: input.workspaceId,
      reason: config.reason,
    });
    return { status: "skipped", reason: config.reason } as const;
  }

  const client = options?.client ?? getResendClient(config.apiKey);
  const firstName = normalizeName(input.firstName);
  const lastName = normalizeName(input.lastName);
  const rendered = renderSignupWelcomeEmail({ firstName });

  try {
    await syncRegisteredUserContact({
      client,
      email: input.email,
      registeredUsersSegmentId: config.registeredUsersSegmentId,
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
    });

    const email = assertResendResponse(
      await client.emails.send(
        {
          from: config.from,
          to: input.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          replyTo: config.replyTo,
          tags: [
            { name: "category", value: "transactional" },
            { name: "type", value: "signup_welcome" },
          ],
        },
        { idempotencyKey: `signup-welcome:${input.userId}` },
      ),
      "Unable to send signup welcome email",
    );

    logger.info("Sent signup welcome email", {
      event: "opencompany.signup_welcome_email_sent",
      user_id: input.userId,
      workspace_id: input.workspaceId,
      email_id: email.id,
    });

    return { status: "sent", emailId: email.id } as const;
  } catch (error) {
    captureException(error, {
      event: "opencompany.signup_welcome_email_failed",
      user_id: input.userId,
      workspace_id: input.workspaceId,
    });
    throw error;
  }
}
