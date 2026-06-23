"use client";

import { scheduleNextRunAt, scheduleSummary } from "@opencompany/agent-runtime";
import type { AgentConfig, AgentScheduleTriggerConfig } from "@opencompany/agent-runtime/types";
import { useQueryClient } from "@tanstack/react-query";
import { Clock3, Loader2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { ScheduleDialog } from "@/components/agent-schedules/ScheduleDialog";
import { showOutOfCreditsToast } from "@/components/billing/out-of-credits-toast";
import { usePersonalAgent } from "@/components/personal/PersonalAgentContext";
import { useToast } from "@/components/ToastProvider";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { runAgentScheduleNow } from "@/lib/agent-schedules/actions";
import { seedSessionQueries } from "@/lib/agent-sessions/payload";
import { updatePersonalAgentSchedules } from "@/lib/personal/actions";
import { personalPaths } from "@/lib/personal/paths";

function scheduleTriggers(triggers: readonly unknown[]): AgentScheduleTriggerConfig[] {
  return triggers.filter((trigger): trigger is AgentScheduleTriggerConfig => {
    if (!trigger || typeof trigger !== "object" || !("type" in trigger)) return false;
    return trigger.type === "agent.schedule";
  });
}

function RoutineStatusPill({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
        enabled
          ? "border-success-border bg-success-bg text-success"
          : "border-border bg-surface text-ink-subtle"
      }`}
    >
      {enabled ? "on" : "off"}
    </span>
  );
}

function RoutineRow({
  routine,
  now,
  isPending,
  isRunning,
  onEdit,
  onDelete,
  onToggle,
  onRunNow,
}: {
  routine: AgentScheduleTriggerConfig;
  now: Date;
  isPending: boolean;
  isRunning: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onRunNow: () => void;
}) {
  return (
    <article className="rounded-lg border border-border bg-surface/55 px-4 py-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-surface/70 bg-surface/70 text-ink-muted">
          <Clock3 size={15} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-[13.5px] font-medium text-ink">
                  {scheduleSummary(routine)}
                </h2>
                <RoutineStatusPill enabled={routine.enabled} />
              </div>
              <p className="mt-1 truncate text-[11.5px] text-ink-subtle">
                {nextRunLabel(routine, now)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={onRunNow}
                disabled={isPending || isRunning}
                aria-label="Run routine now"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isRunning ? (
                  <Loader2 size={13} strokeWidth={1.9} className="animate-spin" />
                ) : (
                  <Play size={13} strokeWidth={1.9} />
                )}
              </button>
              <button
                type="button"
                onClick={onToggle}
                disabled={isPending}
                aria-label={routine.enabled ? "Disable routine" : "Enable routine"}
                className="inline-flex h-7 min-w-10 items-center justify-center rounded-md border border-border bg-surface px-2 text-[11.5px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {routine.enabled ? "Off" : "On"}
              </button>
              <button
                type="button"
                onClick={onEdit}
                disabled={isPending}
                aria-label="Edit routine"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Pencil size={13} strokeWidth={1.9} />
              </button>
              <button
                type="button"
                onClick={onDelete}
                disabled={isPending}
                aria-label="Delete routine"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-ink-muted transition-colors duration-150 hover:bg-danger-bg hover:text-danger focus:outline-none focus-visible:ring-1 focus-visible:ring-danger/25 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Trash2 size={13} strokeWidth={1.9} />
              </button>
            </div>
          </div>
          <div className="mt-3">
            <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
              Prompt
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-5 text-ink-muted">
              {routine.prompt}
            </p>
          </div>
        </div>
      </div>
    </article>
  );
}

export function PersonalRoutinesView() {
  const { agent, config, setConfig, userTimezone } = usePersonalAgent();
  const { workspaceId } = useWorkspaceContext();
  const { showError, showToast } = useToast();
  const queryClient = useQueryClient();
  const router = useRouter();
  const routines = useMemo(() => scheduleTriggers(config.triggers), [config.triggers]);
  const [dialogSchedule, setDialogSchedule] = useState<AgentScheduleTriggerConfig | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [runningScheduleId, setRunningScheduleId] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  function persistRoutines(next: AgentScheduleTriggerConfig[]) {
    const normalized = next.map((routine) => ({ ...routine, timezone: userTimezone }));
    const previousConfig = config;
    setConfig(withSchedules(config, normalized));
    startTransition(async () => {
      const result = await updatePersonalAgentSchedules(agent.id, normalized);
      if (!result.ok) {
        setConfig(previousConfig);
        showError(result.error, "Could not save routine");
        return;
      }
      setConfig(result.config);
    });
  }

  function saveRoutine(trigger: AgentScheduleTriggerConfig) {
    persistRoutines(upsertScheduleTrigger(routines, trigger));
    setShowDialog(false);
    setDialogSchedule(null);
  }

  function deleteRoutine(triggerId: string) {
    persistRoutines(routines.filter((routine) => routine.id !== triggerId));
  }

  function toggleRoutine(trigger: AgentScheduleTriggerConfig) {
    persistRoutines(
      routines.map((routine) =>
        routine.id === trigger.id ? { ...routine, enabled: !routine.enabled } : routine,
      ),
    );
  }

  function runRoutineNow(triggerId: string) {
    startTransition(async () => {
      setRunningScheduleId(triggerId);
      try {
        const result = await runAgentScheduleNow(agent.id, triggerId);
        if (!result.ok) {
          if ("redirectTo" in result) {
            showOutOfCreditsToast({
              showToast,
              router,
              redirectTo: personalPaths.settings + "?billing=insufficient",
            });
            return;
          }
          showError(result.error, "Could not run routine");
          return;
        }
        seedSessionQueries(queryClient, workspaceId, result.detail);
        router.push(personalPaths.session(result.session.id));
      } finally {
        setRunningScheduleId(null);
      }
    });
  }

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-6 py-10">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Routines</h1>
            <p className="mt-1 text-[13px] leading-5 text-ink-muted">
              {routines.length} {routines.length === 1 ? "routine" : "routines"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setDialogSchedule(null);
              setShowDialog(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12.5px] font-medium text-ink/85 transition-colors duration-150 hover:bg-surface-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <Plus size={12.5} strokeWidth={1.9} />
            New routine
          </button>
        </div>

        <div className="mt-6 space-y-3">
          {routines.map((routine) => (
            <RoutineRow
              key={routine.id}
              routine={routine}
              now={now}
              isPending={isPending}
              isRunning={runningScheduleId === routine.id}
              onEdit={() => {
                setDialogSchedule(routine);
                setShowDialog(true);
              }}
              onDelete={() => deleteRoutine(routine.id)}
              onToggle={() => toggleRoutine(routine)}
              onRunNow={() => runRoutineNow(routine.id)}
            />
          ))}
          {routines.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-surface/45 px-4 py-8 text-center">
              <Clock3
                size={18}
                strokeWidth={1.9}
                className="mx-auto text-ink-subtle"
                aria-hidden="true"
              />
              <p className="mt-3 text-[13px] font-medium text-ink">No routines yet</p>
              <p className="mx-auto mt-1 max-w-[360px] text-[12.5px] leading-5 text-ink-muted">
                Run your personal agent on a schedule.
              </p>
              <button
                type="button"
                onClick={() => {
                  setDialogSchedule(null);
                  setShowDialog(true);
                }}
                className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas transition-colors duration-150 hover:bg-ink/90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                <Plus size={13} strokeWidth={1.9} />
                New routine
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {showDialog ? (
        <ScheduleDialog
          schedule={dialogSchedule}
          existingIds={routines.map((routine) => routine.id)}
          defaultTimezone={userTimezone}
          showTimezone={false}
          title={dialogSchedule ? "Edit routine" : "New routine"}
          onClose={() => {
            setShowDialog(false);
            setDialogSchedule(null);
          }}
          onSave={saveRoutine}
          {...(dialogSchedule
            ? {
                onRemove: () => {
                  deleteRoutine(dialogSchedule.id);
                  setShowDialog(false);
                  setDialogSchedule(null);
                },
              }
            : {})}
        />
      ) : null}
    </main>
  );
}

function withSchedules(config: AgentConfig, schedules: AgentScheduleTriggerConfig[]): AgentConfig {
  return {
    ...config,
    triggers: [
      ...schedules,
      ...config.triggers.filter((trigger) => trigger.type !== "agent.schedule"),
    ],
  };
}

function upsertScheduleTrigger(
  triggers: AgentScheduleTriggerConfig[],
  next: AgentScheduleTriggerConfig,
) {
  const index = triggers.findIndex((trigger) => trigger.id === next.id);
  if (index === -1) return [...triggers, next];
  return triggers.map((trigger, triggerIndex) => (triggerIndex === index ? next : trigger));
}

function nextRunLabel(routine: AgentScheduleTriggerConfig, now: Date) {
  if (!routine.enabled) return "Paused";
  const nextRunAt = scheduleNextRunAt(routine, now);
  if (!nextRunAt) return "No upcoming run";
  return `Next run ${relativeNextRun(nextRunAt, now)} · ${localNextRunTime(
    nextRunAt,
    routine.timezone,
    now,
  )}`;
}

function relativeNextRun(nextRunAt: Date, now: Date) {
  const minutes = Math.max(1, Math.ceil((nextRunAt.getTime() - now.getTime()) / 60_000));
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in about ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(minutes / (24 * 60));
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}

function localNextRunTime(nextRunAt: Date, timezone: string, now: Date) {
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(nextRunAt);
  const nextKey = localDateKey(nextRunAt, timezone);
  const todayKey = localDateKey(now, timezone);
  const tomorrowKey = localDateKey(new Date(now.getTime() + 24 * 60 * 60_000), timezone);

  if (nextKey === todayKey) return `today at ${time}`;
  if (nextKey === tomorrowKey) return `tomorrow at ${time}`;

  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
  }).format(nextRunAt);
  return `${day} at ${time}`;
}

function localDateKey(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}
