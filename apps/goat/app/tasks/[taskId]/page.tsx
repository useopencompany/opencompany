import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TaskDetailPanel } from "@/components/TaskDetailPanel";
import { buildGoatHarnessRun } from "@/lib/task-harness-run";
import { getCurrentUserGoatTaskRun } from "@/lib/tasks";

export const dynamic = "force-dynamic";

type TaskDetailPageProps = {
  params: Promise<{
    taskId: string;
  }>;
};

export default async function TaskDetailPage({ params }: TaskDetailPageProps) {
  const { taskId } = await params;
  const runData = await getCurrentUserGoatTaskRun(taskId);

  if (!runData) {
    notFound();
  }

  const { task, messages, events, modelUsage, toolUsage, sandboxUsage } = runData;
  const run = buildGoatHarnessRun({
    task,
    messages,
    events,
    modelUsage,
    toolUsage,
    sandboxUsage,
  });

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[720px] flex-col gap-8 pb-24 pt-16 sm:pt-24">
          <Link
            href="/"
            className="inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <ArrowLeft size={14} strokeWidth={2} />
            Results
          </Link>

          <TaskDetailPanel initialRun={run} />
        </div>
      </div>
    </main>
  );
}
