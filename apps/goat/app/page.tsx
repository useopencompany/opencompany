import { GoatSurface, type GoatTaskView } from "@/components/GoatSurface";
import { listCurrentUserRecentGoatChats, loadCurrentGoatChatSessionById } from "@/lib/chat";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import { listCurrentUserGoatTasks } from "@/lib/tasks";

export const dynamic = "force-dynamic";

type GoatHomePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function GoatHomePage({ searchParams }: GoatHomePageProps) {
  const params = await searchParams;
  const chatParam = Array.isArray(params.chat) ? params.chat[0] : params.chat;
  const [tasks, initialChat, recentChats] = await Promise.all([
    listCurrentUserGoatTasks(),
    loadCurrentGoatChatSessionById(chatParam),
    listCurrentUserRecentGoatChats(),
  ]);
  const taskViews = tasks.map(
    (task): GoatTaskView => ({
      id: task.id,
      displayId: task.displayId,
      name: task.name,
      prompt: task.prompt,
      model: task.model,
      status: task.status,
      stage: task.stage,
      result: task.result,
      error: task.error,
      archivedAt: task.archivedAt?.toISOString() ?? null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    }),
  );

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <GoatSurface
        tasks={taskViews}
        defaultModel={DEFAULT_GOAT_MODEL}
        initialChat={initialChat}
        recentChats={recentChats}
      />
    </main>
  );
}
