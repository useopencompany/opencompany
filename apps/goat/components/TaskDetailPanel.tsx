"use client";

import { getAgentModelDefinition } from "@opencompany/agent-runtime";
import { toast } from "@opencompany/ui/components/sonner";
import { CircleDotDashed, Square, TerminalSquare } from "lucide-react";
import { useState, useTransition } from "react";
import { TaskActivitySection } from "@/components/TaskActivityFeed";
import type { GoatTaskView } from "@/lib/task-board";
import { formatGoatStartedAt, GOAT_STATUS_COPY } from "@/lib/task-display";
import { cancelGoatTaskAction } from "@/lib/tasks";

export function TaskDetailPanel({ task }: { task: GoatTaskView }) {
  const isActive = task.status === "queued" || task.status === "running";

  return (
    <>
      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <h1 className="min-w-0 flex-1 text-[34px] font-semibold leading-tight tracking-normal text-ink">
            {task.name}
          </h1>
          {isActive ? <StopTaskButton taskId={task.id} /> : null}
        </div>
      </header>

      <section className="flex flex-col gap-1">
        <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Task
        </h2>
        <DetailRow label="ID" value={task.displayId} />
        <DetailRow label="Started" value={formatGoatStartedAt(task.createdAt)} />
        <DetailRow label="Model" value={getAgentModelDefinition(task.model)?.label ?? task.model} />
        <DetailRow
          label="Engine"
          value={task.engine === "codex" ? "Codex" : "OpenCompany"}
          icon="engine"
        />
        <DetailRow label="Status" value={GOAT_STATUS_COPY[task.status]} active={isActive} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Description
        </h2>
        <p className="whitespace-pre-wrap px-2 text-[13px] leading-6 text-ink-muted">
          {task.prompt}
        </p>
      </section>

      <TaskActivitySection taskId={task.id} isActive={isActive} />
    </>
  );
}

function StopTaskButton({ taskId }: { taskId: string }) {
  const [isPending, startTransition] = useTransition();
  const [stopRequested, setStopRequested] = useState(false);
  const disabled = isPending || stopRequested;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        setStopRequested(true);
        startTransition(async () => {
          try {
            const result = await cancelGoatTaskAction(taskId);
            if (result.ok) return;
            setStopRequested(false);
            toast.error(result.error ?? "Could not stop task.");
          } catch {
            setStopRequested(false);
            toast.error("Could not stop task.");
          }
        });
      }}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] font-medium text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <Square size={12} strokeWidth={2} />
      {disabled ? "Stopping" : "Stop"}
    </button>
  );
}

function DetailRow({
  label,
  value,
  active = false,
  icon = "status",
}: {
  label: string;
  value: string;
  active?: boolean;
  icon?: "status" | "engine";
}) {
  const Icon = icon === "engine" ? TerminalSquare : CircleDotDashed;
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2">
      <Icon
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
