"use client";

import { useGoatAppData } from "@/components/GoatAppDataProvider";
import { GoatSurface } from "@/components/GoatSurface";
import { TaskRunLiveProvider } from "@/components/TaskRunPanel";
import type { GoatChatSessionView } from "@/lib/chat-ui";
import { normalizeGoatModel } from "@/lib/model-options";
import { goatHarnessRunToChatMessages } from "@/lib/task-chat-messages";
import type { GoatHarnessRunViewModel } from "@/lib/task-harness-run";

export function TaskDetailPanel({ initialRun }: { initialRun: GoatHarnessRunViewModel }) {
  const data = useGoatAppData();
  const userName = data.user.firstName?.trim() || data.user.email.split("@")[0] || "there";

  return (
    <TaskRunLiveProvider initialRun={initialRun}>
      {(run) => {
        const initialChat: GoatChatSessionView = {
          id: run.task.id,
          title: run.task.name,
          model: normalizeGoatModel(run.task.model),
          // Task-backed turns use the task continuation action for every
          // engine, including Codex tasks with their own persisted session.
          engine: "opencompany",
          messages: goatHarnessRunToChatMessages(run),
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
            chatResumeEnabled={false}
            userName={userName}
            userWorkosId={data.user.workosUserId}
            taskConversation={{
              taskId: run.task.id,
              status: run.task.status,
              startedAtMs: taskActivityStartedAtMs(run),
            }}
          />
        );
      }}
    </TaskRunLiveProvider>
  );
}

function taskActivityStartedAtMs(run: GoatHarnessRunViewModel) {
  const parsed = Date.parse(run.task.updatedAt || run.task.createdAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
