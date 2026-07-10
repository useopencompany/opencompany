import { GoatHomeRoute } from "@/components/GoatRoutes";
import { loadCurrentGoatChatSessionById } from "@/lib/chat";

type GoatChatPageProps = {
  params: Promise<{ chatId: string }>;
};

export default async function GoatChatPage({ params }: GoatChatPageProps) {
  const { chatId } = await params;
  const trimmedChatId = chatId.trim();
  const initialChat = trimmedChatId ? await loadCurrentGoatChatSessionById(trimmedChatId) : null;
  return <GoatHomeRoute chatId={trimmedChatId || null} initialChat={initialChat} />;
}
