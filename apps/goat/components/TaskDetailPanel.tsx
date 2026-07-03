"use client";

import { CircleDollarSign, CircleDotDashed, TerminalSquare } from "lucide-react";
import Link from "next/link";
import { TaskHarnessRunView } from "@/components/TaskHarnessRunView";
import { TaskRunLiveProvider } from "@/components/TaskRunPanel";
import { formatUsdMicros } from "@/lib/cost-format";
import { formatGoatStartedAt, GOAT_STAGE_COPY, GOAT_STATUS_COPY } from "@/lib/task-display";
import type { GoatHarnessRunViewModel, GoatRunCostSummary } from "@/lib/task-harness-run";

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

      <CostSection cost={run.cost} />

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

function CostSection({ cost }: { cost: GoatRunCostSummary }) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
        Cost
      </h2>
      <DetailRow label="Total" value={formatUsdMicros(cost.totalCostUsdMicros)} icon="cost" />
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-3">
        <CostMiniRow label="Model" value={formatUsdMicros(cost.modelCostUsdMicros)} />
        <CostMiniRow label="Tools" value={formatUsdMicros(cost.toolCostUsdMicros)} />
        <CostMiniRow label="Sandbox" value={formatUsdMicros(cost.sandboxCostUsdMicros)} />
      </div>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        <CostMiniRow label="Provider" value={formatUsdMicros(cost.providerCostUsdMicros)} />
        <CostMiniRow label="Platform" value={formatUsdMicros(cost.platformFeeUsdMicros)} />
      </div>
      {cost.toolUsageByProviderOperation.length > 0 ? (
        <div className="mt-1 flex flex-col gap-1">
          {cost.toolUsageByProviderOperation.map((usage) => (
            <div
              key={`${usage.provider}:${usage.operation}`}
              className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-[12.5px]"
            >
              <span className="min-w-0 truncate text-ink-subtle">
                {usage.provider} / {usage.operation} ({usage.calls})
              </span>
              <span className="shrink-0 font-medium text-ink">
                {formatUsdMicros(usage.costUsdMicros)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {!cost.hasRecordedCosts ? (
        <p className="px-2 pt-1 text-[12px] leading-5 text-ink-muted">
          Costs are recorded for new runs.
        </p>
      ) : null}
    </section>
  );
}

function CostMiniRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-[12.5px]">
      <span className="text-ink-subtle">{label}</span>
      <span className="font-medium text-ink">{value}</span>
    </div>
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
  icon?: "status" | "cost";
}) {
  const Icon = icon === "cost" ? CircleDollarSign : CircleDotDashed;
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
