"use client";

import { useLiveQuery } from "@tanstack/react-db";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { TaskHarnessRunView } from "@/components/TaskHarnessRunView";
import { useHydrated } from "@/components/useHydrated";
import {
  createGoatCollections,
  type GoatTaskEventRow,
  type GoatTaskMessageRow,
  type GoatTaskModelUsageRow,
  type GoatTaskRow,
  type GoatTaskSandboxUsageRow,
  type GoatTaskToolUsageRow,
} from "@/lib/task-collections";
import { buildGoatHarnessRun, type GoatHarnessRunViewModel } from "@/lib/task-harness-run";

export function TaskRunPanel({ initialRun }: { initialRun: GoatHarnessRunViewModel }) {
  return (
    <TaskRunLiveProvider initialRun={initialRun}>
      {(run) => <TaskHarnessRunView run={run} />}
    </TaskRunLiveProvider>
  );
}

export function TaskRunLiveProvider({
  initialRun,
  children,
}: {
  initialRun: GoatHarnessRunViewModel;
  children: (run: GoatHarnessRunViewModel) => ReactNode;
}) {
  const hydrated = useHydrated();
  if (!hydrated) return children(initialRun);
  return <LiveTaskRunProvider initialRun={initialRun}>{children}</LiveTaskRunProvider>;
}

function LiveTaskRunProvider({
  initialRun,
  children,
}: {
  initialRun: GoatHarnessRunViewModel;
  children: (run: GoatHarnessRunViewModel) => ReactNode;
}) {
  const collections = useMemo(() => createGoatCollections(), []);
  const scoped = useMemo(
    () => collections.taskRunCollections(initialRun.task.id),
    [collections, initialRun.task.id],
  );
  const { data: taskRows, isLoading: taskLoading } = useLiveQuery((q) =>
    q.from({ task: collections.tasks }),
  );
  const { data: messageRows, isLoading: messagesLoading } = useLiveQuery((q) =>
    q.from({ message: scoped.messages }),
  );
  const { data: eventRows, isLoading: eventsLoading } = useLiveQuery((q) =>
    q.from({ event: scoped.events }),
  );
  const { data: modelUsageRows, isLoading: modelUsageLoading } = useLiveQuery((q) =>
    q.from({ usage: scoped.modelUsage }),
  );
  const { data: toolUsageRows, isLoading: toolUsageLoading } = useLiveQuery((q) =>
    q.from({ usage: scoped.toolUsage }),
  );
  const { data: sandboxUsageRows, isLoading: sandboxUsageLoading } = useLiveQuery((q) =>
    q.from({ usage: scoped.sandboxUsage }),
  );

  const run = useMemo(() => {
    if (
      taskLoading &&
      messagesLoading &&
      eventsLoading &&
      modelUsageLoading &&
      toolUsageLoading &&
      sandboxUsageLoading
    ) {
      return initialRun;
    }
    const liveTask = (taskRows ?? []).find(
      (task) => task.id === initialRun.task.id || task.display_id === initialRun.task.displayId,
    );
    const liveMessages = (messageRows ?? []) as GoatTaskMessageRow[];
    const liveEvents = (eventRows ?? []) as GoatTaskEventRow[];
    const liveModelUsage = (modelUsageRows ?? []) as GoatTaskModelUsageRow[];
    const liveToolUsage = (toolUsageRows ?? []) as GoatTaskToolUsageRow[];
    const liveSandboxUsage = (sandboxUsageRows ?? []) as GoatTaskSandboxUsageRow[];
    const costRowsLoading = modelUsageLoading || toolUsageLoading || sandboxUsageLoading;
    const hasLiveCostRows =
      liveModelUsage.length > 0 || liveToolUsage.length > 0 || liveSandboxUsage.length > 0;
    if (
      !liveTask &&
      liveMessages.length === 0 &&
      liveEvents.length === 0 &&
      liveModelUsage.length === 0 &&
      liveToolUsage.length === 0 &&
      liveSandboxUsage.length === 0
    ) {
      return initialRun;
    }
    const liveRun = buildGoatHarnessRun({
      task: (liveTask ?? taskFromInitialRun(initialRun)) as GoatTaskRow,
      messages: liveMessages,
      events: liveEvents,
      modelUsage: costRowsLoading ? [] : liveModelUsage,
      toolUsage: costRowsLoading ? [] : liveToolUsage,
      sandboxUsage: costRowsLoading ? [] : liveSandboxUsage,
      ...(costRowsLoading || !hasLiveCostRows ? { cost: initialRun.cost } : {}),
    });
    return applyInitialCostFloor(liveRun, initialRun);
  }, [
    eventRows,
    eventsLoading,
    initialRun,
    messageRows,
    messagesLoading,
    modelUsageLoading,
    modelUsageRows,
    sandboxUsageLoading,
    sandboxUsageRows,
    taskLoading,
    taskRows,
    toolUsageLoading,
    toolUsageRows,
  ]);

  return children(run);
}

export function applyInitialCostFloor(
  liveRun: GoatHarnessRunViewModel,
  initialRun: GoatHarnessRunViewModel,
): GoatHarnessRunViewModel {
  if (liveRun.cost.totalCostUsdMicros >= initialRun.cost.totalCostUsdMicros) {
    return liveRun;
  }

  return {
    ...liveRun,
    cost: initialRun.cost,
  };
}

function taskFromInitialRun(run: GoatHarnessRunViewModel): GoatTaskRow {
  return {
    id: run.task.id,
    display_id: run.task.displayId,
    name: run.task.name,
    user_workos_id: "",
    prompt: run.task.prompt,
    model: run.task.model,
    schedule_id: null,
    scheduled_for: null,
    status: run.task.status,
    stage: run.task.stage,
    result: run.task.result || null,
    error: run.task.error || null,
    harness_spec: {},
    debug_trace: {},
    sandbox_id: null,
    attempts: 0,
    next_run_at: run.task.createdAt,
    lease_id: null,
    lease_owner: null,
    lease_expires_at: null,
    archived_at: null,
    created_at: run.task.createdAt,
    updated_at: run.task.updatedAt,
  };
}
