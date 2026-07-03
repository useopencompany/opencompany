import { ArrowLeft, ChevronRight, CircleDotDashed, TerminalSquare } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/Markdown";
import { TaskAutoRefresh } from "@/components/TaskAutoRefresh";
import { formatGoatStartedAt, GOAT_STAGE_COPY, GOAT_STATUS_COPY } from "@/lib/task-display";
import { deriveGoatTaskSteps } from "@/lib/task-steps";
import { getCurrentUserGoatTask } from "@/lib/tasks";

export const dynamic = "force-dynamic";

type TaskDetailPageProps = {
  params: Promise<{
    taskId: string;
  }>;
};

export default async function TaskDetailPage({ params }: TaskDetailPageProps) {
  const { taskId } = await params;
  const task = await getCurrentUserGoatTask(taskId);

  if (!task) {
    notFound();
  }

  const isActive = task.status === "queued" || task.status === "running";
  const plannerDebug = task.debugTrace?.planner ?? null;
  const harnessDebug = task.debugTrace?.harness ?? null;
  const taskSteps = deriveGoatTaskSteps(task);

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <TaskAutoRefresh enabled={isActive} />
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[560px] flex-col gap-8 pb-24 pt-16 sm:pt-24">
          <Link
            href="/"
            className="inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <ArrowLeft size={14} strokeWidth={2} />
            Results
          </Link>

          <header className="flex flex-col gap-3">
            <h1 className="text-[34px] font-semibold leading-tight tracking-normal text-ink">
              {task.name}
            </h1>
          </header>

          <section className="flex flex-col gap-1">
            <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
              Task
            </h2>
            <DetailRow label="ID" value={task.displayId} />
            <DetailRow label="Started" value={formatGoatStartedAt(task.createdAt)} />
            <DetailRow
              label="Status"
              value={`${GOAT_STATUS_COPY[task.status]} - ${GOAT_STAGE_COPY[task.stage]}`}
              active={isActive}
            />
          </section>

          <section className="flex flex-col gap-1">
            <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
              Result
            </h2>
            {task.result ? (
              <Markdown
                content={task.result}
                className="rounded-lg bg-surface-muted px-3 py-2.5 text-[13px] leading-5 text-ink"
              />
            ) : task.error ? (
              <div className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2.5 text-[13px] leading-5 text-danger">
                {task.error}
              </div>
            ) : (
              <p className="px-2 py-2 text-[13px] leading-5 text-ink-subtle">Result pending.</p>
            )}
          </section>

          <section className="flex flex-col gap-1">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
                What happened
              </h2>
              <Link
                href={`/tasks/${task.displayId}/run`}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[11.5px] font-medium text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                <TerminalSquare size={12} strokeWidth={1.8} />
                View full harness run
              </Link>
            </div>
            <ol className="mt-1 flex flex-col gap-1 border-l border-border pl-3">
              {taskSteps.map((step, index) => (
                <li
                  key={`${index}-${step}`}
                  className="flex gap-2 text-[12.5px] leading-5 text-ink-muted"
                >
                  <span className="shrink-0 tabular-nums text-ink-subtle">{index + 1}.</span>
                  <span className="min-w-0 flex-1">{step}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
              Debug
            </h2>
            <DebugJsonBlock
              label="Harness spec"
              value={task.harnessSpec}
              emptyText="No harness spec captured yet."
            />
            <DebugJsonBlock
              label="Planner turn"
              value={plannerDebug}
              emptyText="No planner debug captured yet."
            />
            <DebugJsonBlock
              label="Task model turns"
              value={harnessDebug}
              emptyText="No model turns captured yet."
            />
          </section>
        </div>
      </div>
    </main>
  );
}

function DetailRow({
  label,
  value,
  active = false,
}: {
  label: string;
  value: string;
  active?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2">
      <CircleDotDashed
        size={16}
        strokeWidth={2}
        className={`shrink-0 ${active ? "animate-[spin_3s_linear_infinite] text-amber-500" : "text-ink-subtle"}`}
      />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="w-16 shrink-0 text-[12.5px] leading-tight text-ink-subtle">{label}</span>
        <span className="truncate text-[14px] font-medium leading-tight text-ink">{value}</span>
      </div>
    </div>
  );
}

function DebugJsonBlock({
  label,
  value,
  emptyText,
}: {
  label: string;
  value: unknown;
  emptyText: string;
}) {
  const json = toPrettyJson(value);

  return (
    <details className="group rounded-lg border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={14}
          strokeWidth={2}
          className="shrink-0 text-ink-subtle transition-transform duration-150 group-open:rotate-90"
        />
        {label}
      </summary>
      {json ? (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-border border-t px-3 py-2.5 font-mono text-[11.5px] leading-5 text-ink">
          {json}
        </pre>
      ) : (
        <p className="border-border border-t px-3 py-2.5 text-[13px] leading-5 text-ink-subtle">
          {emptyText}
        </p>
      )}
    </details>
  );
}

function toPrettyJson(value: unknown) {
  if (value == null) return "";
  if (Array.isArray(value) && value.length === 0) return "";
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 0
  ) {
    return "";
  }
  return JSON.stringify(value, null, 2);
}
