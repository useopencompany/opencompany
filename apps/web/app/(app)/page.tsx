import { redirect } from "next/navigation";
import { HomeRoute } from "@/components/Routes";

type HomePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function HomePage({ searchParams }: HomePageProps) {
  const params = await searchParams;
  const chatParam = Array.isArray(params.chat) ? params.chat[0] : params.chat;
  const chatId = chatParam?.trim();
  if (chatId) redirect(`/chat/${encodeURIComponent(chatId)}`);
  return <HomeRoute chatId={null} />;
}
