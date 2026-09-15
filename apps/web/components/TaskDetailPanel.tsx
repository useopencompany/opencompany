"use client";

import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import { useAppData } from "@/components/AppDataProvider";
import { Surface } from "@/components/Surface";
import { useHydrated } from "@/components/useHydrated";
import type { ChatSessionView } from "@/lib/chat-ui";
import {
  getHeadlessChatRuns,
  type HeadlessChatRunReadModel,
} from "@/lib/headless-chat-collections";
import { legacyHarnessRunToChatMessages } from "@/lib/legacy-task-chat-messages";
import { normalizeModel } from "@/lib/model-options";
import type { HarnessRunViewModel } from "@/lib/task-harness-run";

// Pane contract, forwarded to Surface: an embedded host (the review queue) detaches this view
// itself instead of letting it navigate home and cancel a run that is still going.
export type TaskDetailPaneProps = {
  onClosePane?: () => void;
};

export function TaskDetailPanel({
  initialRun,
  ...pane
}: { initialRun: HarnessRunViewModel } & TaskDetailPaneProps) {
  if (initialRun.task.sessionId) {
    return (
      <CanonicalTaskDetailPanel
        run={initialRun}
        conversationId={initialRun.task.sessionId}
        {...pane}
      />
    );
  }
  return <LegacyTaskDetailPanel initialRun={initialRun} {...pane} />;
}

function CanonicalTaskDetailPanel({
  run,
  conversationId,
  ...pane
}: {
  run: HarnessRunViewModel;
  conversationId: string;
} & TaskDetailPaneProps) {
  const hydrated = useHydrated();
  if (!hydrated) {
    return (
      <CanonicalTaskDetailView
        run={run}
        conversationId={conversationId}
        activeRun={null}
        {...pane}
      />
    );
  }
  return <LiveCanonicalTaskDetailPanel run={run} conversationId={conversationId} {...pane} />;
}

function LiveCanonicalTaskDetailPanel({
  run,
  conversationId,
  ...pane
}: {
  run: HarnessRunViewModel;
  conversationId: string;
} & TaskDetailPaneProps) {
  const runsCollection = useMemo(() => getHeadlessChatRuns(conversationId), [conversationId]);
  const { data: runRows } = useLiveQuery(
    (query) => query.from({ run: runsCollection }),
    [runsCollection],
  );
  const activeRun = useMemo(
    () =>
      ((runRows ?? []) as HeadlessChatRunReadModel[])
        .filter((candidate) => ["queued", "running", "paused"].includes(candidate.status))
        .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null,
    [runRows],
  );

  return (
    <CanonicalTaskDetailView
      run={run}
      conversationId={conversationId}
      activeRun={activeRun}
      {...pane}
    />
  );
}

function CanonicalTaskDetailView({
  run,
  conversationId,
  activeRun,
  ...pane
}: {
  run: HarnessRunViewModel;
  conversationId: string;
  activeRun: HeadlessChatRunReadModel | null;
} & TaskDetailPaneProps) {
  const data = useAppData();
  const liveTask = data.tasks?.find((task) => task.id === run.task.id);
  const initialChat: ChatSessionView = useMemo(
    () => ({
      id: conversationId,
      title: liveTask?.name.trim() || taskDetailTitle(run),
      model: normalizeModel(run.task.model),
      engine: run.task.engine,
      messages: run.chat?.messages ?? [],
    }),
    [conversationId, liveTask?.name, run],
  );

  return (
    <Surface
      key={data.activeBrain?.id ?? "no-brain"}
      tasks={data.tasks}
      allTasks={data.allTasks}
      defaultModel={initialChat.model}
      initialChat={initialChat}
      recentChats={data.recentChats}
      archivedChats={data.archivedChats}
      codexConnected={data.codexConnected}
      claudeCodeConnected={data.claudeCodeConnected}
      workspaceId={data.workspace.id}
      userWorkosId={data.user.workosUserId}
      {...pane}
      taskConversation={{
        taskId: run.task.id,
        status: activeRun
          ? activeRun.status === "paused"
            ? "waiting"
            : activeRun.status === "queued"
              ? "queued"
              : "running"
          : (liveTask?.status ?? run.task.status),
        startedAtMs: taskTurnStartedAtMs(liveTask ?? run.task, activeRun?.createdAt),
        activeRunId: activeRun?.id ?? null,
      }}
    />
  );
}

function LegacyTaskDetailPanel({
  initialRun,
  ...pane
}: { initialRun: HarnessRunViewModel } & TaskDetailPaneProps) {
  const data = useAppData();
  const title = taskDetailTitle(initialRun);
  const initialChat: ChatSessionView = {
    id: initialRun.task.id,
    title,
    model: normalizeModel(initialRun.task.model),
    engine: "opencompany",
    messages: legacyHarnessRunToChatMessages(initialRun),
  };

  return (
    <Surface
      key={data.activeBrain?.id ?? "no-brain"}
      tasks={data.tasks}
      allTasks={data.allTasks}
      defaultModel={initialChat.model}
      initialChat={initialChat}
      recentChats={data.recentChats}
      archivedChats={data.archivedChats}
      codexConnected={data.codexConnected}
      claudeCodeConnected={data.claudeCodeConnected}
      workspaceId={data.workspace.id}
      userWorkosId={data.user.workosUserId}
      {...pane}
      taskConversation={{
        taskId: initialRun.task.id,
        status: initialRun.task.status,
        startedAtMs: taskTurnStartedAtMs(initialRun.task),
      }}
      readOnlyNotice="This pre-cutover task is available as read-only history. Start a new task to continue the work."
    />
  );
}

function taskDetailTitle(run: HarnessRunViewModel) {
  return run.task.name.trim() || run.chat?.title.trim() || "Task";
}

function taskTurnStartedAtMs(
  task: Pick<HarnessRunViewModel["task"], "createdAt" | "updatedAt">,
  activeRunCreatedAt?: string,
) {
  for (const timestamp of [activeRunCreatedAt, task.updatedAt, task.createdAt]) {
    if (!timestamp) continue;
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}
