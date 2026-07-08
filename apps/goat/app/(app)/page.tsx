import { GoatHomeRoute } from "@/components/GoatRoutes";

type GoatHomePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function GoatHomePage({ searchParams }: GoatHomePageProps) {
  const params = await searchParams;
  const chatParam = Array.isArray(params.chat) ? params.chat[0] : params.chat;
  return <GoatHomeRoute chatId={chatParam?.trim() || null} />;
}
