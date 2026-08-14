import { updateTaskForActor } from "@opencompany/agent/application/task-creation";
import type { ChatMessageAttachment } from "@opencompany/agent/chat-attachment-formats";
import type { SkillMentionRef } from "@opencompany/agent/skills";
import { createTaskFromWorkflow as createSharedTaskFromWorkflow } from "@opencompany/agent/workflow-tasks";
import type { WorkflowMentionRef } from "@opencompany/agent/workflows";
import { generateChatTitle } from "@/lib/chat-title";
import { isClaudeCodeConnectedForUser } from "@/lib/claude-code-auth";
import { isCodexConnectedForUser } from "@/lib/codex-auth";
import { getAvailableHarnessTools } from "@/lib/integrations/google-data";
import { resolveSkillMentions } from "@/lib/skills";
import { createTaskForUser } from "@/lib/tasks";
import { resolveWorkflowMention } from "@/lib/workflows";

export * from "@opencompany/agent/workflow-tasks";

export function createTaskFromWorkflow(input: {
  userWorkosId: string;
  workspaceId: string | null;
  mention: WorkflowMentionRef;
  skillMentions?: SkillMentionRef[];
  description: string;
  attachments?: ChatMessageAttachment[];
  attachmentTexts?: Record<string, string> | null;
}) {
  return createSharedTaskFromWorkflow(input, {
    createTask: ({ actorId, ...task }) =>
      createTaskForUser({
        ...task,
        userWorkosId: actorId,
        source: "workflow",
      }),
    resolveWorkflow: resolveWorkflowMention,
    preparation: {
      isCodexConnected: isCodexConnectedForUser,
      isClaudeCodeConnected: isClaudeCodeConnectedForUser,
      resolveSkills: resolveSkillMentions,
      getAvailableTools: getAvailableHarnessTools,
    },
  });
}

// Chat- and trigger-created workflow tasks share this: the task is created instantly with the
// workflow name, then renamed to a cheap one-line summary of the request once generation lands.
export async function generateWorkflowTaskTitle(input: {
  taskId: string;
  userWorkosId: string;
  workspaceId: string;
  workflowName: string;
  description: string;
  apiKey?: string | null;
}): Promise<void> {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) return;
  try {
    const title = await generateChatTitle({
      content: input.description,
      fallbackTitle: input.workflowName,
      apiKey,
      userWorkosId: input.userWorkosId,
    });
    if (!title || title === input.workflowName) return;
    await updateTaskForActor({
      actorId: input.userWorkosId,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      name: title,
    });
  } catch {
    // Keep the workflow-name fallback; a missing pretty title is not worth failing anything.
  }
}
