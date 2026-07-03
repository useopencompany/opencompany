import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TaskRunPanel } from "@/components/TaskRunPanel";
import { buildGoatHarnessRun } from "@/lib/task-harness-run";
import { getCurrentUserGoatTaskRun } from "@/lib/tasks";

export const dynamic = "force-dynamic";

type TaskHarnessRunPageProps = {
  params: Promise<{
    taskId: string;
  }>;
};

export default async function TaskHarnessRunPage({ params }: TaskHarnessRunPageProps) {
  const { taskId } = await params;
  const runData = await getCurrentUserGoatTaskRun(taskId);

  if (!runData) {
    notFound();
  }

  const { task, messages, events } = runData;
  const run = buildGoatHarnessRun({ task, messages, events });

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-5">
        <div className="flex w-full max-w-[880px] flex-col gap-8 pb-24 pt-14 sm:pt-20">
          <nav className="flex flex-wrap items-center gap-2">
            <Link
              href={`/tasks/${task.displayId}`}
              className="inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              <ArrowLeft size={14} strokeWidth={2} />
              Task detail
            </Link>
            <Link
              href="/"
              className="inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              Results
            </Link>
          </nav>

          <header className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <h1 className="text-[34px] font-semibold leading-tight tracking-normal text-ink">
                {task.name}
              </h1>
              <div className="text-[12.5px] leading-5 text-ink-muted">Task run</div>
            </div>
          </header>

          <TaskRunPanel initialRun={run} />
        </div>
      </div>
    </main>
  );
}
