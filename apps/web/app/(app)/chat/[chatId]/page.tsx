import { redirect } from "next/navigation";
import { GoatHomeRoute } from "@/components/GoatRoutes";
import { loadCurrentGoatChatSessionById } from "@/lib/chat";

type GoatChatPageProps = {
  params: Promise<{ chatId: string }>;
};

export default async function GoatChatPage({ params }: GoatChatPageProps) {
  const { chatId } = await params;
  const trimmedChatId = chatId.trim();
  if (!trimmedChatId) redirect("/");
  const initialChat = await loadCurrentGoatChatSessionById(trimmedChatId);
  if (!initialChat) redirect("/");
  return <GoatHomeRoute chatId={trimmedChatId} initialChat={initialChat} />;
}
