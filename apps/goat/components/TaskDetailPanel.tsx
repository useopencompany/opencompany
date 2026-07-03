"use client";

import { CircleDotDashed, TerminalSquare } from "lucide-react";
import Link from "next/link";
import { TaskHarnessRunView } from "@/components/TaskHarnessRunView";
import { TaskRunLiveProvider } from "@/components/TaskRunPanel";
import { formatGoatStartedAt, GOAT_STAGE_COPY, GOAT_STATUS_COPY } from "@/lib/task-display";
import type { GoatHarnessRunViewModel } from "@/lib/task-harness-run";

export function TaskDetailPanel({ initialRun }: { initialRun: GoatHarnessRunViewModel }) {
  return (
    <TaskRunLiveProvider initialRun={initialRun}>
      {(run) => <TaskDetailContent run={run} />}
    </TaskRunLiveProvider>
  );
}

function TaskDetailContent({ run }: { run: GoatHarnessRunViewModel }) {
  const task = run.task;
  const isActive = task.status === "queued" || task.status === "running";

  return (
    <>
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

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
            Run
          </h2>
          <Link
            href={`/tasks/${task.displayId}/run`}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[11.5px] font-medium text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <TerminalSquare size={12} strokeWidth={1.8} />
            Full run
          </Link>
        </div>
        <TaskHarnessRunView run={run} />
      </section>
    </>
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
