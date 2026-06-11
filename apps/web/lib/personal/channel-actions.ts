"use server";

import { getDb } from "@opencompany/db/client";
import { messagingChannels } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { currentWorkspace } from "@/lib/auth";
import { getWhatsAppProvider } from "@/lib/messaging/config";
import { newMessagingChannelId, newMessagingLinkToken } from "@/lib/messaging/ids";
import { renderQrSvg } from "@/lib/messaging/qr";
import { WHATSAPP_PROVIDER } from "@/lib/personal/channels";
import { ensurePersonalAgent } from "@/lib/personal/scaffold";

// The link QR is short-lived: a fresh token is minted each time the user clicks Connect.
const LINK_TOKEN_TTL_MS = 30 * 60 * 1000;

// Begin (or restart) linking. Mints a one-time token, flips the channel to pending_link, and returns
// the wa.me deep link + an inline QR for the user to scan. Bound to the user's personal agent only.
export async function connectWhatsappChannel(): Promise<
  { ok: true; deeplink: string; qrSvg: string; expiresAt: string } | { ok: false; error: string }
> {
  const provider = getWhatsAppProvider();
  if (!provider) {
    return { ok: false, error: "WhatsApp isn't configured on this deployment yet." };
  }

  const { authUser, user, workspace } = await currentWorkspace();
  const agentName = user.firstName?.trim() || authUser.email.split("@")[0] || "You";
  const agent = await ensurePersonalAgent({
    userId: user.id,
    workspaceId: workspace.id,
    name: agentName,
  });

  const db = getDb();
  const token = newMessagingLinkToken();
  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);

  await db
    .insert(messagingChannels)
    .values({
      id: newMessagingChannelId(),
      workspaceId: workspace.id,
      userId: user.id,
      agentId: agent.id,
      provider: WHATSAPP_PROVIDER,
      status: "pending_link",
      linkToken: token,
      linkTokenExpiresAt: expiresAt,
    })
    .onConflictDoUpdate({
      target: [messagingChannels.workspaceId, messagingChannels.userId, messagingChannels.provider],
      set: {
        // Re-point the binding to the personal agent in case it changed, and reset the link state.
        agentId: agent.id,
        status: "pending_link",
        linkToken: token,
        linkTokenExpiresAt: expiresAt,
        lastError: null,
        updatedAt: new Date(),
      },
    });

  const deeplink = provider.buildLinkDeeplink({ token });
  if (!deeplink) {
    return { ok: false, error: "WhatsApp linking is unavailable." };
  }
  const qrSvg = await renderQrSvg(deeplink);
  return { ok: true, deeplink, qrSvg, expiresAt: expiresAt.toISOString() };
}

// Disconnect the channel: drop the binding + active session pointer so inbound messages from the
// previously-linked number fall through to the not-linked path.
export async function disconnectWhatsappChannel(): Promise<{ ok: true }> {
  const { user, workspace } = await currentWorkspace();
  const db = getDb();
  await db
    .update(messagingChannels)
    .set({
      status: "disconnected",
      externalId: null,
      profileName: null,
      linkToken: null,
      linkTokenExpiresAt: null,
      activeSessionId: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(messagingChannels.workspaceId, workspace.id),
        eq(messagingChannels.userId, user.id),
        eq(messagingChannels.provider, WHATSAPP_PROVIDER),
      ),
    );
  return { ok: true };
}
