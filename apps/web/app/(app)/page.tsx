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
  // Set by a sidebar Project's new-chat control. The id is only ever handed back to the API, which
  // rejects a project the reader does not own.
  const projectParam = Array.isArray(params.project) ? params.project[0] : params.project;
  return <HomeRoute chatId={null} projectId={projectParam?.trim() || null} />;
}
