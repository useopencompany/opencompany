"use client";

import type { ChatSessionView } from "@opencompany/core/chat-ui";
import { useAppData } from "@/components/AppDataProvider";
import { ChatSurface } from "@/components/ChatSurface";
import { TaskRunLiveProvider } from "@/components/TaskRunPanel";
import { legacyHarnessRunToChatMessages } from "@/lib/legacy-task-chat-messages";
import { normalizeModel } from "@/lib/model-options";
import type { HarnessRunViewModel } from "@/lib/task-harness-run";

export function TaskDetailPanel({ initialRun }: { initialRun: HarnessRunViewModel }) {
  const data = useAppData();
  const userName = data.user.firstName?.trim() || data.user.email.split("@")[0] || "there";

  return (
    <TaskRunLiveProvider initialRun={initialRun}>
      {(run) => {
        const title = taskDetailTitle(run);
        // Session-backed tasks are already ordinary chats. Only pre-cutover
        // legacy rows need the compatibility projection from task_messages.
        const initialChat: ChatSessionView = run.chat
          ? { ...run.chat, title }
          : {
              id: run.task.id,
              title,
              model: normalizeModel(run.task.model),
              engine: "opencompany",
              messages: legacyHarnessRunToChatMessages(run),
            };

        return (
          <ChatSurface
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

function taskDetailTitle(run: HarnessRunViewModel) {
  return run.task.name.trim() || run.chat?.title.trim() || "Task";
}

function taskActivityStartedAtMs(run: HarnessRunViewModel) {
  const parsed = Date.parse(run.task.updatedAt || run.task.createdAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
