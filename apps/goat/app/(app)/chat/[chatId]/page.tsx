import { GoatHomeRoute } from "@/components/GoatRoutes";

type GoatChatPageProps = {
  params: Promise<{ chatId: string }>;
};

export default async function GoatChatPage({ params }: GoatChatPageProps) {
  const { chatId } = await params;
  return <GoatHomeRoute chatId={chatId.trim() || null} />;
}
