"use client";

import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import { useAppData } from "@/components/AppDataProvider";
import { Surface } from "@/components/Surface";
import type { ChatSessionView } from "@/lib/chat-ui";
import {
  getHeadlessChatRuns,
  type HeadlessChatRunReadModel,
} from "@/lib/headless-chat-collections";
import { legacyHarnessRunToChatMessages } from "@/lib/legacy-task-chat-messages";
import { normalizeModel } from "@/lib/model-options";
import type { HarnessRunViewModel } from "@/lib/task-harness-run";

export function TaskDetailPanel({ initialRun }: { initialRun: HarnessRunViewModel }) {
  if (initialRun.task.sessionId) {
    return <CanonicalTaskDetailPanel run={initialRun} conversationId={initialRun.task.sessionId} />;
  }
  return <LegacyTaskDetailPanel initialRun={initialRun} />;
}

function CanonicalTaskDetailPanel({
  run,
  conversationId,
}: {
  run: HarnessRunViewModel;
  conversationId: string;
}) {
  const data = useAppData();
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
  const initialChat: ChatSessionView = {
    id: conversationId,
    title,
    model: normalizeModel(run.task.model),
    engine: run.task.engine,
    messages: run.chat?.messages ?? [],
  };

  return (
    <Surface
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

function LegacyTaskDetailPanel({ initialRun }: { initialRun: HarnessRunViewModel }) {
  const data = useAppData();
  const userName = data.user.firstName?.trim() || data.user.email.split("@")[0] || "there";
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

function taskDetailTitle(run: HarnessRunViewModel) {
  return run.task.name.trim() || run.chat?.title.trim() || "Task";
}

function taskActivityStartedAtMs(run: HarnessRunViewModel) {
  const parsed = Date.parse(run.task.updatedAt || run.task.createdAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
