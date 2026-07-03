import { GoatSurface, type GoatTaskView } from "@/components/GoatSurface";
import { loadCurrentGoatChatSession } from "@/lib/chat";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import { listCurrentUserGoatTasks } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export default async function GoatHomePage() {
  const [tasks, initialChat] = await Promise.all([
    listCurrentUserGoatTasks(),
    loadCurrentGoatChatSession(),
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
      <GoatSurface tasks={taskViews} defaultModel={DEFAULT_GOAT_MODEL} initialChat={initialChat} />
    </main>
  );
}
