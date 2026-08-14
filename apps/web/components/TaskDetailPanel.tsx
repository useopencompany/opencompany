"use client";

import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import { useGoatAppData } from "@/components/GoatAppDataProvider";
import { GoatSurface } from "@/components/GoatSurface";
import type { GoatChatSessionView } from "@/lib/chat-ui";
import {
  getHeadlessChatRuns,
  type HeadlessChatRunReadModel,
} from "@/lib/headless-chat-collections";
import { legacyGoatHarnessRunToChatMessages } from "@/lib/legacy-task-chat-messages";
import { normalizeGoatModel } from "@/lib/model-options";
import type { GoatHarnessRunViewModel } from "@/lib/task-harness-run";

export function TaskDetailPanel({ initialRun }: { initialRun: GoatHarnessRunViewModel }) {
  if (initialRun.task.sessionId) {
    return <CanonicalTaskDetailPanel run={initialRun} conversationId={initialRun.task.sessionId} />;
  }
  return <LegacyTaskDetailPanel initialRun={initialRun} />;
}

function CanonicalTaskDetailPanel({
  run,
  conversationId,
}: {
  run: GoatHarnessRunViewModel;
  conversationId: string;
}) {
  const data = useGoatAppData();
  const userName = data.user.firstName?.trim() || data.user.email.split("@")[0] || "there";
  const runsCollection = useMemo(() => getHeadlessChatRuns(conversationId), [conversationId]);
  const { data: runRows } = useLiveQuery(
    (query) => query.from({ run: runsCollection }),
    [runsCollection],
  );
  const liveTask = data.tasks?.find((task) => task.id === run.task.id);
  const activeRun = useMemo(
    () =>
      ((runRows ?? []) as HeadlessChatRunReadModel[])
        .filter((candidate) => ["queued", "running", "paused"].includes(candidate.status))
        .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null,
    [runRows],
  );
  const title = taskDetailTitle(run);
  const initialChat: GoatChatSessionView = {
    id: conversationId,
    title,
    model: normalizeGoatModel(run.task.model),
    engine: run.task.engine,
    messages: run.chat?.messages ?? [],
  };

  return (
    <GoatSurface
      key={data.activeBrain?.id ?? "no-brain"}
      tasks={data.tasks}
      schedules={data.schedules}
      defaultModel={initialChat.model}
      initialChat={initialChat}
      recentChats={data.recentChats}
      archivedChats={data.archivedChats}
      codexConnected={data.codexConnected}
      claudeCodeConnected={data.claudeCodeConnected}
      taskSpawningEnabled={data.featureFlags.taskSpawning}
      userName={userName}
      userWorkosId={data.user.workosUserId}
      taskConversation={{
        taskId: run.task.id,
        status: activeRun ? "running" : (liveTask?.status ?? run.task.status),
        startedAtMs: taskActivityStartedAtMs(run),
        sessionBacked: true,
        activeRunId: activeRun?.id ?? null,
      }}
    />
  );
}

function LegacyTaskDetailPanel({ initialRun }: { initialRun: GoatHarnessRunViewModel }) {
  const data = useGoatAppData();
  const userName = data.user.firstName?.trim() || data.user.email.split("@")[0] || "there";
  const title = taskDetailTitle(initialRun);
  const initialChat: GoatChatSessionView = {
    id: initialRun.task.id,
    title,
    model: normalizeGoatModel(initialRun.task.model),
    engine: "opencompany",
    messages: legacyGoatHarnessRunToChatMessages(initialRun),
  };

  return (
    <GoatSurface
      key={data.activeBrain?.id ?? "no-brain"}
      tasks={data.tasks}
      schedules={data.schedules}
      defaultModel={initialChat.model}
      initialChat={initialChat}
      recentChats={data.recentChats}
      archivedChats={data.archivedChats}
      codexConnected={data.codexConnected}
      claudeCodeConnected={data.claudeCodeConnected}
      taskSpawningEnabled={data.featureFlags.taskSpawning}
      userName={userName}
      userWorkosId={data.user.workosUserId}
      taskConversation={{
        taskId: initialRun.task.id,
        status: initialRun.task.status,
        startedAtMs: taskActivityStartedAtMs(initialRun),
        sessionBacked: false,
      }}
    />
  );
}

function taskDetailTitle(run: GoatHarnessRunViewModel) {
  return run.task.name.trim() || run.chat?.title.trim() || "Task";
}

function taskActivityStartedAtMs(run: GoatHarnessRunViewModel) {
  const parsed = Date.parse(run.task.updatedAt || run.task.createdAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
