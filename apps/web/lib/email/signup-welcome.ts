import { captureException, createLogger } from "@opencompany/observability";
import {
  assertResendResponse,
  getResendClient,
  isResendNotFoundError,
  type ResendEmailClient,
  trimmed,
} from "@/lib/email/client";
import { renderSignupWelcomeEmail } from "@/lib/email/templates/signup-welcome";
import { createEmailUnsubscribeUrl } from "@/lib/email/unsubscribe";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

const DEFAULT_WELCOME_FROM = "Louis from opencompany <louis@updates.opencompany.cloud>";
const DEFAULT_REPLY_TO = "louis@opencompany.cloud";

export type SignupWelcomeEmailInput = {
  userId: string;
  workspaceId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
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

async function loadContact(client: ResendEmailClient, email: string) {
  const response = await client.contacts.get({ email });

  if (response.error) {
    if (isResendNotFoundError(response.error)) return null;
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

    if (contact.unsubscribed) {
      return { unsubscribed: true } as const;
    }
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
    return { unsubscribed: false } as const;
  }

  assertResendResponse(
    await input.client.contacts.segments.add({
      email: input.email,
      segmentId: input.registeredUsersSegmentId,
    }),
    "Unable to add Resend contact to Registered Users segment",
  );

  return { unsubscribed: false } as const;
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
  const unsubscribeUrl = createEmailUnsubscribeUrl({
    email: input.email,
    type: "signup_welcome",
  });
  const rendered = renderSignupWelcomeEmail({ firstName, unsubscribeUrl });

  try {
    const contactSync = await syncRegisteredUserContact({
      client,
      email: input.email,
      registeredUsersSegmentId: config.registeredUsersSegmentId,
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
    });

    if (contactSync.unsubscribed) {
      logger.info("Skipped signup welcome email because contact is unsubscribed", {
        event: "opencompany.signup_welcome_email_skipped",
        user_id: input.userId,
        workspace_id: input.workspaceId,
        reason: "unsubscribed",
      });
      return { status: "skipped", reason: "unsubscribed" } as const;
    }

    const email = assertResendResponse(
      await client.emails.send(
        {
          from: config.from,
          to: input.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          replyTo: config.replyTo,
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
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

export { renderSignupWelcomeEmail };
