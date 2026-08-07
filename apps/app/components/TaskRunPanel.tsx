"use client";

import { useLiveQuery } from "@tanstack/react-db";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useHydrated } from "@/components/useHydrated";
import {
  createCollections,
  type TaskEventRow,
  type TaskMessageRow,
  type TaskModelUsageRow,
  type TaskRow,
  type TaskSandboxUsageRow,
  type TaskToolUsageRow,
} from "@/lib/task-collections";
import { buildHarnessRun, type HarnessRunViewModel } from "@/lib/task-harness-run";

export function TaskRunLiveProvider({
  initialRun,
  children,
}: {
  initialRun: HarnessRunViewModel;
  children: (run: HarnessRunViewModel) => ReactNode;
}) {
  const hydrated = useHydrated();
  if (!hydrated) return children(initialRun);
  return <LiveTaskRunProvider initialRun={initialRun}>{children}</LiveTaskRunProvider>;
}

function LiveTaskRunProvider({
  initialRun,
  children,
}: {
  initialRun: HarnessRunViewModel;
  children: (run: HarnessRunViewModel) => ReactNode;
}) {
  const collections = useMemo(() => createCollections(), []);
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
    const liveMessages = (messageRows ?? []) as TaskMessageRow[];
    const liveEvents = (eventRows ?? []) as TaskEventRow[];
    const liveModelUsage = (modelUsageRows ?? []) as TaskModelUsageRow[];
    const liveToolUsage = (toolUsageRows ?? []) as TaskToolUsageRow[];
    const liveSandboxUsage = (sandboxUsageRows ?? []) as TaskSandboxUsageRow[];
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
    const liveRun = buildHarnessRun({
      task: (liveTask ?? taskFromInitialRun(initialRun)) as TaskRow,
      messages: liveMessages,
      events: liveEvents,
      modelUsage: costRowsLoading ? [] : liveModelUsage,
      toolUsage: costRowsLoading ? [] : liveToolUsage,
      sandboxUsage: costRowsLoading ? [] : liveSandboxUsage,
      chat: initialRun.chat,
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
  liveRun: HarnessRunViewModel,
  initialRun: HarnessRunViewModel,
): HarnessRunViewModel {
  if (liveRun.cost.totalCostUsdMicros >= initialRun.cost.totalCostUsdMicros) {
    return liveRun;
  }

  return {
    ...liveRun,
    cost: initialRun.cost,
  };
}

function taskFromInitialRun(run: HarnessRunViewModel): TaskRow {
  return {
    id: run.task.id,
    display_id: run.task.displayId,
    name: run.task.name,
    user_workos_id: "",
    workspace_id: null,
    prompt: run.task.prompt,
    model: run.task.model,
    session_id: run.task.sessionId,
    schedule_id: null,
    scheduled_for: null,
    workflow_id: run.task.workflowId,
    workflow_brain_ref: null,
    status: run.task.status,
    stage: run.task.stage,
    result: run.task.result || null,
    error: run.task.error || null,
    reported_outcome: run.task.reportedOutcome,
    outcome_comment: run.task.outcomeComment,
    harness_spec: run.harnessConfig?.rawSpec ?? {},
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
