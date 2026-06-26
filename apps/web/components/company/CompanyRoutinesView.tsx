"use client";

import { scheduleSummary } from "@opencompany/agent-runtime";
import type { AgentScheduleTriggerConfig } from "@opencompany/agent-runtime/types";
import { useLiveQuery } from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Clock3, Loader2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { ScheduleDialog } from "@/components/agent-schedules/ScheduleDialog";
import { showOutOfCreditsToast } from "@/components/billing/out-of-credits-toast";
import { useCollections } from "@/components/CollectionsProvider";
import { useToast } from "@/components/ToastProvider";
import { useHydrated } from "@/components/useHydrated";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { runAgentScheduleNow, updateWorkspaceAgentSchedules } from "@/lib/agent-schedules/actions";
import {
  nextRunLabel,
  scheduleTriggers,
  upsertScheduleTrigger,
} from "@/lib/agent-schedules/format";
import { seedSessionQueries } from "@/lib/agent-sessions/payload";
import type { AgentRow } from "@/lib/collections/types";

type RoutineItem = { agent: AgentRow; routine: AgentScheduleTriggerConfig };

type DialogState =
  | { mode: "create"; agentId: string }
  | { mode: "edit"; agentId: string; schedule: AgentScheduleTriggerConfig };

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
  item,
  now,
  isPending,
  isRunning,
  onEdit,
  onDelete,
  onToggle,
  onRunNow,
}: {
  item: RoutineItem;
  now: Date;
  isPending: boolean;
  isRunning: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onRunNow: () => void;
}) {
  const { agent, routine } = item;
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
                <h2 className="truncate text-[13.5px] font-medium text-ink">{agent.name}</h2>
                <RoutineStatusPill enabled={routine.enabled} />
              </div>
              <p className="mt-1 truncate text-[12px] text-ink-muted">{scheduleSummary(routine)}</p>
              <p className="mt-0.5 truncate text-[11.5px] text-ink-subtle">
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

function RoutinesShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-6 py-10">{children}</div>
    </main>
  );
}

function RoutinesSkeleton() {
  return (
    <RoutinesShell>
      <div className="h-[18px] w-32 animate-pulse rounded bg-surface-muted" />
      <div className="mt-6 space-y-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="h-24 animate-pulse rounded-lg border border-border bg-surface/40"
          />
        ))}
      </div>
    </RoutinesShell>
  );
}

function CompanyRoutinesLive() {
  const { workspaceId } = useWorkspaceContext();
  const { agents: agentsCollection } = useCollections();
  const { data: rows, isLoading } = useLiveQuery((q) => q.from({ agent: agentsCollection }));
  const { showError, showToast } = useToast();
  const queryClient = useQueryClient();
  const router = useRouter();

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [runningRoutineId, setRunningRoutineId] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  // Company agents only — workspace agents (user_id null), the same set as /company/agents.
  const companyAgents = useMemo(
    () =>
      (rows ?? [])
        .filter((row) => row.user_id === null)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [rows],
  );
  const agentsById = useMemo(
    () => new Map(companyAgents.map((agent) => [agent.id, agent])),
    [companyAgents],
  );
  const agentOptions = useMemo(
    () => companyAgents.map((agent) => ({ id: agent.id, name: agent.name })),
    [companyAgents],
  );
  const routineItems = useMemo<RoutineItem[]>(
    () =>
      companyAgents.flatMap((agent) =>
        scheduleTriggers(agent.config.triggers).map((routine) => ({ agent, routine })),
      ),
    [companyAgents],
  );

  function persistAgentRoutines(agentId: string, next: AgentScheduleTriggerConfig[]) {
    startTransition(async () => {
      const result = await updateWorkspaceAgentSchedules(agentId, next);
      if (!result.ok) showError(result.error, "Could not save routine");
      // The agents Electric collection streams the updated row back, refreshing the list.
    });
  }

  function handleSave(trigger: AgentScheduleTriggerConfig) {
    if (!dialog) return;
    const agent = agentsById.get(dialog.agentId);
    if (agent) {
      const next = upsertScheduleTrigger(scheduleTriggers(agent.config.triggers), trigger);
      persistAgentRoutines(dialog.agentId, next);
    }
    setDialog(null);
  }

  function toggleRoutine(agentId: string, routine: AgentScheduleTriggerConfig) {
    const agent = agentsById.get(agentId);
    if (!agent) return;
    const next = scheduleTriggers(agent.config.triggers).map((item) =>
      item.id === routine.id ? { ...item, enabled: !item.enabled } : item,
    );
    persistAgentRoutines(agentId, next);
  }

  function deleteRoutine(agentId: string, routineId: string) {
    const agent = agentsById.get(agentId);
    if (!agent) return;
    const next = scheduleTriggers(agent.config.triggers).filter((item) => item.id !== routineId);
    persistAgentRoutines(agentId, next);
  }

  function runRoutineNow(agentId: string, routineId: string) {
    startTransition(async () => {
      setRunningRoutineId(`${agentId}:${routineId}`);
      try {
        const result = await runAgentScheduleNow(agentId, routineId);
        if (!result.ok) {
          if ("redirectTo" in result) {
            showOutOfCreditsToast({
              showToast,
              router,
              redirectTo: "/company/settings?billing=insufficient",
            });
            return;
          }
          showError(result.error, "Could not run routine");
          return;
        }
        seedSessionQueries(queryClient, workspaceId, result.detail);
        router.push(`/company/session/${result.session.id}`);
      } finally {
        setRunningRoutineId(null);
      }
    });
  }

  if (isLoading) return <RoutinesSkeleton />;

  const hasAgents = companyAgents.length > 0;
  const dialogAgent = dialog ? agentsById.get(dialog.agentId) : null;
  const dialogExistingIds = dialogAgent
    ? scheduleTriggers(dialogAgent.config.triggers).map((trigger) => trigger.id)
    : [];

  function openCreate() {
    const first = companyAgents[0];
    if (first) setDialog({ mode: "create", agentId: first.id });
  }

  return (
    <RoutinesShell>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Routines</h1>
          <p className="mt-1 text-[13px] leading-5 text-ink-muted">
            {routineItems.length} {routineItems.length === 1 ? "routine" : "routines"} across your
            agents
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          disabled={!hasAgents}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12.5px] font-medium text-ink/85 transition-colors duration-150 hover:bg-surface-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Plus size={12.5} strokeWidth={1.9} />
          New routine
        </button>
      </div>

      <div className="mt-6 space-y-3">
        {routineItems.map((item) => (
          <RoutineRow
            key={`${item.agent.id}:${item.routine.id}`}
            item={item}
            now={now}
            isPending={isPending}
            isRunning={runningRoutineId === `${item.agent.id}:${item.routine.id}`}
            onEdit={() =>
              setDialog({ mode: "edit", agentId: item.agent.id, schedule: item.routine })
            }
            onDelete={() => deleteRoutine(item.agent.id, item.routine.id)}
            onToggle={() => toggleRoutine(item.agent.id, item.routine)}
            onRunNow={() => runRoutineNow(item.agent.id, item.routine.id)}
          />
        ))}

        {routineItems.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-surface/45 px-4 py-8 text-center">
            {hasAgents ? (
              <>
                <Clock3
                  size={18}
                  strokeWidth={1.9}
                  className="mx-auto text-ink-subtle"
                  aria-hidden="true"
                />
                <p className="mt-3 text-[13px] font-medium text-ink">No routines yet</p>
                <p className="mx-auto mt-1 max-w-[360px] text-[12.5px] leading-5 text-ink-muted">
                  Run a company agent on a schedule.
                </p>
                <button
                  type="button"
                  onClick={openCreate}
                  className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas transition-colors duration-150 hover:bg-ink/90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                >
                  <Plus size={13} strokeWidth={1.9} />
                  New routine
                </button>
              </>
            ) : (
              <>
                <Bot
                  size={18}
                  strokeWidth={1.9}
                  className="mx-auto text-ink-subtle"
                  aria-hidden="true"
                />
                <p className="mt-3 text-[13px] font-medium text-ink">No agents yet</p>
                <p className="mx-auto mt-1 max-w-[360px] text-[12.5px] leading-5 text-ink-muted">
                  Create a company agent before scheduling a routine.
                </p>
                <Link
                  href="/company/agents"
                  className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas transition-colors duration-150 hover:bg-ink/90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                >
                  <Bot size={13} strokeWidth={1.9} />
                  Go to Agents
                </Link>
              </>
            )}
          </div>
        ) : null}
      </div>

      {dialog && hasAgents ? (
        <ScheduleDialog
          schedule={dialog.mode === "edit" ? dialog.schedule : null}
          existingIds={dialogExistingIds}
          showTimezone
          title={dialog.mode === "edit" ? "Edit routine" : "New routine"}
          agentOptions={agentOptions}
          selectedAgentId={dialog.agentId}
          onSelectAgent={(agentId) =>
            setDialog((prev) => (prev && prev.mode === "create" ? { ...prev, agentId } : prev))
          }
          agentPickerDisabled={dialog.mode === "edit"}
          onClose={() => setDialog(null)}
          onSave={handleSave}
          {...(dialog.mode === "edit"
            ? {
                onRemove: () => {
                  deleteRoutine(dialog.agentId, dialog.schedule.id);
                  setDialog(null);
                },
              }
            : {})}
        />
      ) : null}
    </RoutinesShell>
  );
}

export default function CompanyRoutinesView() {
  // useLiveQuery relies on useSyncExternalStore with no SSR snapshot, so the live view must
  // only mount after hydration (mirrors AgentsView).
  const hydrated = useHydrated();
  if (!hydrated) return <RoutinesSkeleton />;
  return <CompanyRoutinesLive />;
}
