import { redirect } from "next/navigation";
import { HomeRoute } from "@/components/Routes";
import { currentUser } from "@/lib/auth";
import { loadCurrentChatSessionById } from "@/lib/chat";

type ChatPageProps = {
  params: Promise<{ chatId: string }>;
};

export default async function ChatPage({ params }: ChatPageProps) {
  // Layouts and pages can render in parallel. Finish the auth boundary here before this page starts
  // a protected API read, so an expired session follows the sign-in redirect instead of surfacing
  // the API's expected 401 as an unhandled server error.
  await currentUser();
  const { chatId } = await params;
  const trimmedChatId = chatId.trim();
  if (!trimmedChatId) redirect("/");
  const initialChat = await loadCurrentChatSessionById(trimmedChatId);
  return <HomeRoute chatId={trimmedChatId} initialChat={initialChat} />;
}
