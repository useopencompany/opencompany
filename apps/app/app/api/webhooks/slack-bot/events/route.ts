import {
  claimGoatSlackBotEvent,
  completeGoatSlackBotEvent,
  type GoatSlackBotEventClaim,
  getGoatSlackBotThreadParticipation,
  markGoatSlackBotIntegrationStatusForTeam,
  releaseGoatSlackBotEvent,
} from "@opencompany/db/slack-bot";
import { after, NextResponse } from "next/server";
import { goatSlackBotSigningSecret } from "@/lib/integrations/slack-bot";
import { verifyGoatSlackEventSignature } from "@/lib/integrations/slack-signature";
import {
  type GoatSlackBotEventInput,
  processGoatSlackBotDirectMessage,
  processGoatSlackBotMention,
  processGoatSlackBotThreadFollowUp,
} from "@/lib/slack-bot/answer";
import { mentionsOtherHuman } from "@/lib/slack-bot/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;

type SlackEnvelope = {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: Record<string, unknown>;
};

export async function POST(request: Request) {
  const rawBody = await request.text();
  const verified = verifyGoatSlackEventSignature({
    rawBody,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    secret: goatSlackBotSigningSecret(),
  });
  if (!verified) {
    return NextResponse.json({ error: "Invalid Slack signature." }, { status: 401 });
  }

  let envelope: SlackEnvelope;
  try {
    envelope = JSON.parse(rawBody) as SlackEnvelope;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  if (envelope.type === "url_verification") {
    return NextResponse.json({ challenge: envelope.challenge ?? "" });
  }

  // Slack disables event delivery for apps that keep failing, so after the
  // signature check every path acks with 200 — errors are logged, not surfaced.
  try {
    if (envelope.type === "event_callback" && envelope.event && envelope.team_id) {
      return NextResponse.json(
        await handleEventCallback(envelope.team_id, envelope.event_id, envelope.event),
      );
    }
  } catch (error) {
    console.error("[goat-slack-bot] Failed to process Slack event", {
      eventType: envelope.event?.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return NextResponse.json({ ok: true });
}

async function handleEventCallback(
  teamId: string,
  eventId: string | undefined,
  event: Record<string, unknown>,
) {
  if (event.type === "tokens_revoked" || event.type === "app_uninstalled") {
    await markGoatSlackBotIntegrationStatusForTeam({
      teamId,
      status: "needs_reauth",
      statusReason:
        event.type === "app_uninstalled"
          ? "The OpenCompany Slack app was uninstalled from the workspace."
          : "The Slack bot token was revoked.",
    });
    return { ok: true };
  }

  if (event.type === "app_mention" || event.type === "message") {
    const channelId = typeof event.channel === "string" ? event.channel : null;
    const messageTs = typeof event.ts === "string" ? event.ts : null;
    const slackUserId = typeof event.user === "string" ? event.user : null;
    const text = typeof event.text === "string" ? event.text : "";
    const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : null;
    // Loop guard: never answer bots (including ourselves) or system subtypes.
    if (event.bot_id || event.subtype || !slackUserId || !channelId || !messageTs) {
      return { ok: true, dropped: true };
    }

    let kind: "mention" | "follow_up" | "dm";
    if (event.type === "app_mention") {
      kind = "mention";
    } else if (event.channel_type === "im" || channelId.startsWith("D")) {
      kind = "dm";
    } else {
      // Channel messages qualify as mention-free follow-ups only inside a
      // thread the bot participates in. Any @mention disqualifies: a bot
      // mention arrives separately as app_mention (answering here would
      // double-post), and a human mention means the reply is addressed at a
      // person. Both checks run before claiming to keep the claims table lean.
      if (!threadTs) return { ok: true, ignored: true };
      if (mentionsOtherHuman(text, null)) return { ok: true, ignored: true };
      const participation = await getGoatSlackBotThreadParticipation({
        teamId,
        channelId,
        threadTs,
      });
      if (!participation) return { ok: true, ignored: true };
      kind = "follow_up";
    }

    if (!eventId) {
      console.warn("[goat-slack-bot] Dropping Slack event without event_id", {
        teamId,
        channelId,
        kind,
      });
      return { ok: true, dropped: true };
    }

    const claim = await claimGoatSlackBotEvent({ eventId, teamId });
    if (!claim) return { ok: true, skipped: "duplicate" };

    after(
      processClaimedEvent(claim, kind, {
        teamId,
        channelId,
        messageTs,
        threadTs,
        text,
        slackUserId,
      }),
    );
    return { ok: true };
  }

  return { ok: true, ignored: true };
}

async function processClaimedEvent(
  claim: GoatSlackBotEventClaim,
  kind: "mention" | "follow_up" | "dm",
  input: GoatSlackBotEventInput,
) {
  try {
    if (kind === "mention") {
      await processGoatSlackBotMention(input);
    } else if (kind === "follow_up") {
      await processGoatSlackBotThreadFollowUp(input);
    } else {
      await processGoatSlackBotDirectMessage(input);
    }
  } catch (error) {
    await releaseGoatSlackBotEvent(claim).catch((releaseError) => {
      console.error("[goat-slack-bot] Failed to release Slack event claim", {
        eventId: claim.eventId,
        error: releaseError instanceof Error ? releaseError.message : String(releaseError),
      });
    });
    console.error("[goat-slack-bot] Event processing failed", {
      kind,
      teamId: input.teamId,
      channelId: input.channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  await completeGoatSlackBotEvent(claim).catch((error) => {
    // Keep the live lease if completion persistence fails. Releasing it after
    // an answer was posted would let a Slack retry double-post immediately.
    console.error("[goat-slack-bot] Failed to complete Slack event claim", {
      eventId: claim.eventId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
