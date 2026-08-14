import { redirect } from "next/navigation";
import { HomeRoute } from "@/components/Routes";
import { loadCurrentChatSessionById } from "@/lib/chat";

type ChatPageProps = {
  params: Promise<{ chatId: string }>;
};

export default async function ChatPage({ params }: ChatPageProps) {
  const { chatId } = await params;
  const trimmedChatId = chatId.trim();
  if (!trimmedChatId) redirect("/");
  const initialChat = await loadCurrentChatSessionById(trimmedChatId);
  if (!initialChat) redirect("/");
  return <HomeRoute chatId={trimmedChatId} initialChat={initialChat} />;
}
