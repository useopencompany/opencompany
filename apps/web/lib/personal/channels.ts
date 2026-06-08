import { getDb } from "@opencompany/db/client";
import { messagingChannels, messagingMessages } from "@opencompany/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { getWhatsAppProvider, isWhatsAppConfigured } from "@/lib/messaging/config";
import { renderQrSvg } from "@/lib/messaging/qr";

export const WHATSAPP_PROVIDER = "whatsapp";

export type WhatsAppHealthMessage = {
  id: string;
  direction: "inbound" | "outbound";
  status: string;
  preview: string | null;
  createdAt: string;
};

// A live link QR — present only while the channel is pending_link with an unexpired token.
export type WhatsAppPendingLink = {
  deeplink: string;
  qrSvg: string;
  expiresAt: string;
};

export type WhatsAppChannelState = {
  // Whether the platform Meta credentials are present. When false, the tab explains setup is pending
  // and the Connect button is disabled.
  configured: boolean;
  status: "disconnected" | "pending_link" | "connected" | "error";
  // The bound WhatsApp number (wa_id), once linked.
  externalId: string | null;
  profileName: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastError: string | null;
  pendingLink: WhatsAppPendingLink | null;
  recentMessages: WhatsAppHealthMessage[];
};

// Load the WhatsApp channel state for a user's personal agent, for the Channels tab. Self-contained
// (its own DB reads) so it runs only on the channels route, not on every /personal page.
export async function loadWhatsAppChannelState(input: {
  userId: string;
  workspaceId: string;
}): Promise<WhatsAppChannelState> {
  const db = getDb();
  const configured = isWhatsAppConfigured();

  const [channel] = await db
    .select()
    .from(messagingChannels)
    .where(
      and(
        eq(messagingChannels.workspaceId, input.workspaceId),
        eq(messagingChannels.userId, input.userId),
        eq(messagingChannels.provider, WHATSAPP_PROVIDER),
      ),
    )
    .limit(1);

  if (!channel) {
    return {
      configured,
      status: "disconnected",
      externalId: null,
      profileName: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null,
      pendingLink: null,
      recentMessages: [],
    };
  }

  // Rebuild the QR from the live token so a page refresh during linking doesn't lose it.
  let pendingLink: WhatsAppPendingLink | null = null;
  const provider = getWhatsAppProvider();
  if (
    channel.status === "pending_link" &&
    channel.linkToken &&
    channel.linkTokenExpiresAt &&
    channel.linkTokenExpiresAt.getTime() > Date.now() &&
    provider
  ) {
    const deeplink = provider.buildLinkDeeplink({ token: channel.linkToken });
    if (deeplink) {
      pendingLink = {
        deeplink,
        qrSvg: await renderQrSvg(deeplink),
        expiresAt: channel.linkTokenExpiresAt.toISOString(),
      };
    }
  }

  const recent = await db
    .select({
      id: messagingMessages.id,
      direction: messagingMessages.direction,
      status: messagingMessages.status,
      preview: messagingMessages.preview,
      createdAt: messagingMessages.createdAt,
    })
    .from(messagingMessages)
    .where(eq(messagingMessages.channelId, channel.id))
    .orderBy(desc(messagingMessages.createdAt))
    .limit(10);

  return {
    configured,
    status: channel.status as WhatsAppChannelState["status"],
    externalId: channel.externalId,
    profileName: channel.profileName,
    lastInboundAt: channel.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: channel.lastOutboundAt?.toISOString() ?? null,
    lastError: channel.lastError,
    pendingLink,
    recentMessages: recent.map((row) => ({
      id: row.id,
      direction: row.direction as "inbound" | "outbound",
      status: row.status,
      preview: row.preview,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
