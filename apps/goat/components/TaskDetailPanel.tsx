"use client";

import { useGoatAppData } from "@/components/GoatAppDataProvider";
import { GoatSurface } from "@/components/GoatSurface";
import { TaskRunLiveProvider } from "@/components/TaskRunPanel";
import type { GoatChatSessionView } from "@/lib/chat-ui";
import { legacyGoatHarnessRunToChatMessages } from "@/lib/legacy-task-chat-messages";
import { normalizeGoatModel } from "@/lib/model-options";
import type { GoatHarnessRunViewModel } from "@/lib/task-harness-run";

export function TaskDetailPanel({ initialRun }: { initialRun: GoatHarnessRunViewModel }) {
  const data = useGoatAppData();
  const userName = data.user.firstName?.trim() || data.user.email.split("@")[0] || "there";

  return (
    <TaskRunLiveProvider initialRun={initialRun}>
      {(run) => {
        // Session-backed tasks are already ordinary chats. Only pre-cutover
        // legacy rows need the compatibility projection from task_messages.
        const initialChat: GoatChatSessionView = run.chat ?? {
          id: run.task.id,
          title: run.task.name,
          model: normalizeGoatModel(run.task.model),
          engine: "opencompany",
          messages: legacyGoatHarnessRunToChatMessages(run),
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
              sessionBacked: Boolean(run.task.sessionId),
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
