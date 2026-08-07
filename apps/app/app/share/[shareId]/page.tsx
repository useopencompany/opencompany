import { getAppUrl } from "@opencompany/core/app-url";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { SharedChatView } from "@/components/chat/SharedChatView";
import { loadPublicChat } from "@/lib/chat-sharing";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SharedChatPageProps = {
  params: Promise<{ shareId: string }>;
};

const privateShareMetadata = {
  robots: {
    index: false,
    follow: false,
    noarchive: true,
  },
  referrer: "no-referrer",
} satisfies Metadata;

const loadSharedChat = cache(loadPublicChat);

export async function generateMetadata({ params }: SharedChatPageProps): Promise<Metadata> {
  const { shareId } = await params;
  const chat = await loadSharedChat(shareId);
  if (!chat) notFound();

  const title = chat.title.trim() || "Shared chat";
  const shareSubject = sharedChatSubject(chat);
  const description = `${title} — a read-only ${shareSubject} shared from opencompany.`;
  const sharePath = `/share/${encodeURIComponent(chat.shareId)}`;
  const appUrl = getAppUrl();
  const shareUrl = new URL(sharePath, appUrl);
  const imageUrl = new URL(`${sharePath}/opengraph-image`, appUrl);
  const imageAlt = `${title} — shared ${shareSubject} on opencompany`;

  return {
    title,
    description,
    ...privateShareMetadata,
    openGraph: {
      type: "website",
      locale: "en_US",
      url: shareUrl,
      siteName: "opencompany",
      title,
      description,
      images: [
        {
          url: imageUrl,
          width: 1200,
          height: 630,
          type: "image/png",
          alt: imageAlt,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [
        {
          url: imageUrl,
          width: 1200,
          height: 630,
          type: "image/png",
          alt: imageAlt,
        },
      ],
    },
  };
}

export default async function SharedChatPage({ params }: SharedChatPageProps) {
  const { shareId } = await params;
  const chat = await loadSharedChat(shareId);
  if (!chat) notFound();

  return <SharedChatView chat={chat} />;
}

function sharedChatSubject(chat: { kind: string; engine?: string | null | undefined }) {
  if (chat.kind === "task") return "task run";
  if (chat.engine === "codex") return "Codex chat";
  if (chat.engine === "claude_code") return "Claude Code chat";
  return "chat";
}
