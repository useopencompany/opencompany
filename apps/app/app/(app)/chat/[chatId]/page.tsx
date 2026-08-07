import { HomeRoute } from "@/components/AppRoutes";
import { loadCurrentChatSessionById } from "@/lib/chat";

type ChatPageProps = {
  params: Promise<{ chatId: string }>;
};

export default async function ChatPage({ params }: ChatPageProps) {
  const { chatId } = await params;
  const trimmedChatId = chatId.trim();
  const initialChat = trimmedChatId ? await loadCurrentChatSessionById(trimmedChatId) : null;
  return <HomeRoute chatId={trimmedChatId || null} initialChat={initialChat} />;
}
