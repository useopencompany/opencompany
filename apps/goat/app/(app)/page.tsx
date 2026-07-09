import { redirect } from "next/navigation";
import { GoatHomeRoute } from "@/components/GoatRoutes";

type GoatHomePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function GoatHomePage({ searchParams }: GoatHomePageProps) {
  const params = await searchParams;
  const chatParam = Array.isArray(params.chat) ? params.chat[0] : params.chat;
  const chatId = chatParam?.trim();
  if (chatId) redirect(`/chat/${encodeURIComponent(chatId)}`);
  return <GoatHomeRoute chatId={null} />;
}
