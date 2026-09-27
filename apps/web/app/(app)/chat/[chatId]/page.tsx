import { redirect } from "next/navigation";
import { HomeRoute } from "@/components/Routes";
import { currentUser } from "@/lib/auth";
import { loadCurrentChatSessionById } from "@/lib/chat";

type ChatPageProps = {
  params: Promise<{ chatId: string }>;
};

export default async function ChatPage({ params }: ChatPageProps) {
  const { chatId } = await params;
  const trimmedChatId = chatId.trim();
  if (!trimmedChatId) redirect("/");
  await currentUser();
  const initialChat = await loadCurrentChatSessionById(trimmedChatId);
  if (!initialChat) redirect("/");
  return <HomeRoute chatId={trimmedChatId} initialChat={initialChat} />;
}
