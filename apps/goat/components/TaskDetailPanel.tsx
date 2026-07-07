"use client";

import { toast } from "@opencompany/ui/components/sonner";
import {
  ArrowUp,
  Bot,
  CircleDollarSign,
  CircleDotDashed,
  LoaderCircle,
  SlidersHorizontal,
  Square,
  Target,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { TaskHarnessRunView } from "@/components/TaskHarnessRunView";
import { TaskRunLiveProvider } from "@/components/TaskRunPanel";
import { formatUsdMicros } from "@/lib/cost-format";
import { formatGoatStartedAt, GOAT_STAGE_COPY, GOAT_STATUS_COPY } from "@/lib/task-display";
import type {
  GoatHarnessRunViewModel,
  GoatRunHarnessConfig,
  GoatRunModelSummary,
} from "@/lib/task-harness-run";
import { cancelGoatTaskAction, continueGoatTaskAction } from "@/lib/tasks";

const TEXTAREA_MAX_HEIGHT_PX = 180;

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
        <DetailRow
          label="Status"
          value={`${GOAT_STATUS_COPY[task.status]} - ${GOAT_STAGE_COPY[task.stage]}`}
          active={isActive}
        />
        <DetailRow label="Cost" value={formatUsdMicros(run.cost.totalCostUsdMicros)} icon="cost" />
      </section>

      <HarnessConfigSection config={run.harnessConfig} />

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

      <TaskContinuationComposer run={run} />
    </>
  );
}

function TaskContinuationComposer({ run }: { run: GoatHarnessRunViewModel }) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [optimisticMessage, setOptimisticMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const task = run.task;
  const isTerminal = task.status === "succeeded" || task.status === "failed";
  const canContinue = isTerminal && !isPending && !optimisticMessage;
  const showComposer = isTerminal || Boolean(optimisticMessage) || Boolean(formError);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!input) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, [input]);

  useEffect(() => {
    if (!optimisticMessage) return;
    if (
      run.messages.some(
        (message) => message.role === "user" && message.content.trim() === optimisticMessage,
      )
    ) {
      setOptimisticMessage(null);
    }
  }, [optimisticMessage, run.messages]);

  if (!showComposer) return null;

  const submit = () => {
    const content = input.trim();
    if (!content || !canContinue) return;
    setFormError(null);
    setInput("");
    setOptimisticMessage(content);

    startTransition(async () => {
      try {
        const result = await continueGoatTaskAction(task.displayId, content);
        if (result.ok) {
          router.refresh();
          return;
        }
        setOptimisticMessage(null);
        setInput((current) => (current.trim() ? current : content));
        setFormError(result.error);
      } catch {
        setOptimisticMessage(null);
        setInput((current) => (current.trim() ? current : content));
        setFormError("Could not continue task.");
      }
    });
  };

  return (
    <section className="sticky bottom-0 -mx-6 border-border border-t bg-canvas/95 px-6 py-4 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3">
        {optimisticMessage ? (
          <div className="flex justify-start">
            <div className="max-w-full break-words rounded-2xl rounded-tl-md bg-surface-selected px-3.5 py-2.5 text-[14px] leading-6 text-ink opacity-75 md:max-w-[68%]">
              {optimisticMessage}
            </div>
          </div>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="rounded-lg border border-border bg-surface px-3 py-2 shadow-sm"
        >
          <div className="flex min-w-0 items-end gap-2">
            <div className="flex min-h-9 min-w-0 flex-1 flex-col">
              <label
                htmlFor="task-continuation-input"
                className="mb-1 inline-flex items-center gap-1.5 text-[11.5px] font-medium text-ink-muted"
              >
                <Bot size={13} strokeWidth={1.8} />
                Continue task
              </label>
              <textarea
                ref={textareaRef}
                id="task-continuation-input"
                value={input}
                disabled={!canContinue}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    submit();
                  }
                }}
                rows={1}
                placeholder={canContinue ? "Steer this task worker" : "Task worker is running"}
                className="min-h-8 w-full resize-none bg-transparent text-[14px] leading-6 text-ink outline-none placeholder:text-ink-subtle disabled:cursor-not-allowed disabled:text-ink-muted"
                style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
              />
            </div>
            <button
              type="submit"
              disabled={!input.trim() || !canContinue}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors hover:bg-ink/85 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Continue task"
            >
              {isPending ? (
                <LoaderCircle size={14} strokeWidth={2} className="animate-spin" />
              ) : (
                <ArrowUp size={13} strokeWidth={2} />
              )}
            </button>
          </div>
          {formError ? <p className="mt-2 text-[12px] leading-5 text-danger">{formError}</p> : null}
        </form>
      </div>
    </section>
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
  icon?: "status" | "cost" | "config" | "goal";
}) {
  const Icon =
    icon === "cost"
      ? CircleDollarSign
      : icon === "config"
        ? SlidersHorizontal
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
