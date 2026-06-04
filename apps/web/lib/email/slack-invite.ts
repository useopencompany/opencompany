import { captureException, createLogger } from "@opencompany/observability";
import { Resend, type Response as ResendResponse } from "resend";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

const DEFAULT_FROM = "Louis from OpenCompany <louis@opencompany.cloud>";
const DEFAULT_REPLY_TO = "louis@opencompany.cloud";
const SLACK_INVITE_SUBJECT = "Connect with our team on Slack";

export type SlackInviteEmailInput = {
  userId: string;
  workspaceId: string;
  email: string;
  firstName?: string | null;
  inviteUrl: string;
};

type ResendEmailClient = {
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

type SlackInviteEmailConfig =
  | {
      enabled: true;
      apiKey: string;
      from: string;
      replyTo: string;
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

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Deliverability note: this renders as a plain, left-aligned personal note from a
// real person (single link, no images, no tracking pixel, real reply-to). That
// "1:1 human email" shape is the strongest in-content signal against spam folders.
// The rest of deliverability is domain auth (SPF/DKIM/DMARC) + sender reputation,
// which is infra, not this template.
export function renderSlackInviteEmail(input: {
  firstName?: string | null | undefined;
  inviteUrl: string;
}) {
  const greetingName = trimmed(input.firstName ?? undefined) ?? "there";
  const greeting = `Hi ${greetingName},`;
  const url = input.inviteUrl;
  const safeUrl = escapeHtml(url);

  const text = [
    greeting,
    "",
    "I'm Louis from OpenCompany. Now that you're set up, I'd love to stay close while you get going.",
    "",
    "I've opened a private Slack channel just for your team and ours — the easiest way to reach us. Ask anything, share what's not working, or tell us what you'd like to see next.",
    "",
    `Connect on Slack: ${url}`,
    "",
    "It's just you and the OpenCompany team in there. Not on Slack? Just reply to this email — it comes straight to me.",
    "",
    "Louis",
    "OpenCompany",
  ].join("\n");

  const html = [
    "<!doctype html>",
    '<html lang="en">',
    '<body style="margin:0;padding:0;background:#ffffff;">',
    "<div style=\"max-width:480px;margin:0 auto;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a;\">",
    `<p style="margin:0 0 16px;">${escapeHtml(greeting)}</p>`,
    "<p style=\"margin:0 0 16px;\">I'm Louis from OpenCompany. Now that you're set up, I'd love to stay close while you get going.</p>",
    "<p style=\"margin:0 0 16px;\">I've opened a private Slack channel just for your team and ours — the easiest way to reach us. Ask anything, share what's not working, or tell us what you'd like to see next.</p>",
    `<p style="margin:0 0 20px;"><a href="${safeUrl}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:500;">Connect on Slack</a></p>`,
    `<p style="margin:0 0 16px;color:#6b7280;font-size:13px;">Or paste this link into your browser:<br><a href="${safeUrl}" style="color:#6b7280;">${safeUrl}</a></p>`,
    '<p style="margin:0 0 16px;">It\'s just you and the OpenCompany team in there. Not on Slack? Just reply to this email — it comes straight to me.</p>',
    '<p style="margin:0;">Louis<br><span style="color:#6b7280;">OpenCompany</span></p>',
    "</div>",
    "</body>",
    "</html>",
  ].join("");

  return {
    subject: SLACK_INVITE_SUBJECT,
    text,
    html,
  };
}

function getSlackInviteEmailConfig(): SlackInviteEmailConfig {
  const apiKey = trimmed(process.env.RESEND_API_KEY);

  if (!apiKey) {
    return { enabled: false, reason: "missing_api_key" };
  }

  return {
    enabled: true,
    apiKey,
    from: trimmed(process.env.RESEND_WELCOME_FROM) ?? DEFAULT_FROM,
    replyTo: trimmed(process.env.RESEND_REPLY_TO) ?? DEFAULT_REPLY_TO,
  };
}

function getResendClient(apiKey: string): ResendEmailClient {
  resendClient ??= new Resend(apiKey) as unknown as ResendEmailClient;
  return resendClient;
}

export async function sendSlackInviteEmail(
  input: SlackInviteEmailInput,
  options?: { client?: ResendEmailClient },
) {
  // A failed/pending provisioning has no shareable invite — never send a dead link.
  if (!trimmed(input.inviteUrl)) {
    logger.info("Skipped Slack invite email because there is no invite url", {
      event: "opencompany.slack_invite_email_skipped",
      user_id: input.userId,
      workspace_id: input.workspaceId,
      reason: "no_invite_url",
    });
    return { status: "skipped", reason: "no_invite_url" } as const;
  }

  const config = getSlackInviteEmailConfig();

  if (!config.enabled) {
    logger.info("Skipped Slack invite email because Resend is not configured", {
      event: "opencompany.slack_invite_email_skipped",
      user_id: input.userId,
      workspace_id: input.workspaceId,
      reason: config.reason,
    });
    return { status: "skipped", reason: config.reason } as const;
  }

  const client = options?.client ?? getResendClient(config.apiKey);
  const rendered = renderSlackInviteEmail({
    firstName: input.firstName,
    inviteUrl: input.inviteUrl,
  });

  try {
    const response = await client.emails.send(
      {
        from: config.from,
        to: input.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        replyTo: config.replyTo,
        tags: [
          { name: "category", value: "transactional" },
          { name: "type", value: "slack_invite" },
        ],
      },
      { idempotencyKey: `slack-invite:${input.workspaceId}` },
    );

    if (response.error) {
      throw new Error(`Unable to send Slack invite email: ${response.error.message}`);
    }

    logger.info("Sent Slack invite email", {
      event: "opencompany.slack_invite_email_sent",
      user_id: input.userId,
      workspace_id: input.workspaceId,
      email_id: response.data?.id,
    });

    return { status: "sent", emailId: response.data?.id } as const;
  } catch (error) {
    captureException(error, {
      event: "opencompany.slack_invite_email_failed",
      user_id: input.userId,
      workspace_id: input.workspaceId,
    });
    throw error;
  }
}
