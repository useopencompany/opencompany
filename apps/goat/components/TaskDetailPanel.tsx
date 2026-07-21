"use client";

import { toast } from "@opencompany/ui/components/sonner";
import {
  CircleDollarSign,
  CircleDotDashed,
  SlidersHorizontal,
  Square,
  Target,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { TaskActivitySection } from "@/components/TaskActivityFeed";
import { TaskHarnessRunView } from "@/components/TaskHarnessRunView";
import { TaskRunLiveProvider } from "@/components/TaskRunPanel";
import { formatUsdMicros } from "@/lib/cost-format";
import { formatGoatStartedAt, GOAT_STAGE_COPY, GOAT_STATUS_COPY } from "@/lib/task-display";
import type {
  GoatHarnessRunViewModel,
  GoatRunHarnessConfig,
  GoatRunModelSummary,
} from "@/lib/task-harness-run";
import { cancelGoatTaskAction } from "@/lib/tasks";

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
  const visibleModels = executionRunModels(run.models);

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
        <DetailRow
          label={visibleModels.length === 1 ? "Model" : "Models"}
          value={formatRunModels(visibleModels)}
        />
        <DetailRow label="Engine" value={formatRunEngine(task.engine)} icon="engine" />
        <DetailRow
          label="Status"
          value={`${GOAT_STATUS_COPY[task.status]} - ${GOAT_STAGE_COPY[task.stage]}`}
          active={isActive}
        />
        <DetailRow label="Cost" value={formatUsdMicros(run.cost.totalCostUsdMicros)} icon="cost" />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Description
        </h2>
        <p className="whitespace-pre-wrap px-2 text-[13px] leading-6 text-ink-muted">
          {task.prompt}
        </p>
      </section>

      <TaskActivitySection
        taskId={task.id}
        isActive={isActive}
        legacy={
          <>
            <HarnessConfigSection config={run.harnessConfig} />
            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
                  Run
                </h2>
                <Link
                  href={`/tasks/${task.displayId}/run`}
                  prefetch
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[11.5px] font-medium text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                >
                  <TerminalSquare size={12} strokeWidth={1.8} />
                  Full run
                </Link>
              </div>
              <TaskHarnessRunView run={run} />
            </section>
          </>
        }
      />
    </>
  );
}

function HarnessConfigSection({ config }: { config: GoatRunHarnessConfig | null }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="mb-0.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
        Harness
      </h2>
      {config ? (
        <>
          <DetailRow label="Config" value={formatHarnessConfig(config)} icon="config" />
          {config.codexGoalMode ? (
            <DetailRow label="Goal" value={formatCodexGoalMode(config.codexGoalMode)} icon="goal" />
          ) : null}
          <div className="flex items-start gap-3 rounded-lg px-2 py-2">
            <Wrench size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-ink-subtle" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="text-[12.5px] leading-tight text-ink-subtle">Tools</span>
              {config.tools.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {config.tools.map((tool) => (
                    <span
                      key={tool.id}
                      title={tool.id}
                      className="inline-flex min-h-6 max-w-full items-center rounded-md border border-border bg-surface px-2 py-1 text-[12px] font-medium leading-tight text-ink"
                    >
                      {tool.label}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="text-[13px] leading-tight text-ink-subtle">No tools selected</span>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <SlidersHorizontal size={16} strokeWidth={2} className="shrink-0 text-ink-subtle" />
          <span className="text-[13px] leading-tight text-ink-subtle">
            No harness config recorded.
          </span>
        </div>
      )}
    </section>
  );
}

function formatHarnessConfig(config: GoatRunHarnessConfig) {
  const parts = [config.modelLabel];
  if (config.maxModelSteps) parts.push(`${config.maxModelSteps} max steps`);
  if (config.resultMode) parts.push(formatResultMode(config.resultMode));
  if (config.skills.length > 0) {
    parts.push(`${config.skills.length} ${config.skills.length === 1 ? "skill" : "skills"}`);
  }
  return parts.join(" - ");
}

function formatResultMode(resultMode: string) {
  if (resultMode === "assistant_final") return "Assistant final";
  if (resultMode === "brain_markdown_report") return "Brain report";
  return resultMode;
}

function formatCodexGoalMode(goalMode: NonNullable<GoatRunHarnessConfig["codexGoalMode"]>) {
  const budget = goalMode.tokenBudget ? ` - ${goalMode.tokenBudget} token budget` : "";
  return `${goalMode.objective}${budget}`;
}

function executionRunModels(models: GoatRunModelSummary[]) {
  const executionModels = models.filter((model) => model.phases.includes("execution"));
  return executionModels.length > 0 ? executionModels : models;
}

function formatRunModels(models: GoatRunModelSummary[]) {
  if (models.length === 0) return "Unknown";
  return models.map((model) => model.label || model.id).join(", ");
}

function formatRunEngine(engine: GoatHarnessRunViewModel["task"]["engine"]) {
  return engine === "codex" ? "Codex" : "OpenCompany";
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
  icon?: "status" | "cost" | "config" | "engine" | "goal";
}) {
  const Icon =
    icon === "cost"
      ? CircleDollarSign
      : icon === "config"
        ? SlidersHorizontal
        : icon === "engine"
          ? TerminalSquare
          : icon === "goal"
            ? Target
            : CircleDotDashed;
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
