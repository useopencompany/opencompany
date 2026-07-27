import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SharedChatView } from "@/components/chat/SharedChatView";
import { loadPublicGoatChat } from "@/lib/chat-sharing";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Shared chat - Goat",
  description: "A read-only chat shared from opencompany.",
  robots: {
    index: false,
    follow: false,
    noarchive: true,
  },
  referrer: "no-referrer",
};

export default async function SharedChatPage({ params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  const chat = await loadPublicGoatChat(shareId);
  if (!chat) notFound();

  return <SharedChatView chat={chat} />;
}
