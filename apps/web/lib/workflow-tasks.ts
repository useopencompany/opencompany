import type { GoatChatMessageAttachment, GoatTask } from "@opencompany/db/goat-schema";
import { updateGoatTaskForActor } from "@opencompany/goat-agent/application/task-creation";
import type { GoatSkillMentionRef } from "@opencompany/goat-agent/skills";
import { createGoatTaskFromWorkflow as createSharedGoatTaskFromWorkflow } from "@opencompany/goat-agent/workflow-tasks";
import type { GoatWorkflowMentionRef } from "@opencompany/goat-agent/workflows";
import { generateGoatChatTitle } from "@/lib/chat-title";
import { isGoatClaudeCodeConnectedForUser } from "@/lib/claude-code-auth";
import { isGoatCodexConnectedForUser } from "@/lib/codex-auth";
import { getGoatAvailableHarnessTools } from "@/lib/integrations/google-data";
import { resolveGoatSkillMentions } from "@/lib/skills";
import { createGoatTaskForUser } from "@/lib/tasks";
import { resolveGoatWorkflowMention } from "@/lib/workflows";

export * from "@opencompany/goat-agent/workflow-tasks";

export function createGoatTaskFromWorkflow(input: {
  userWorkosId: string;
  workspaceId: string | null;
  mention: GoatWorkflowMentionRef;
  skillMentions?: GoatSkillMentionRef[];
  description: string;
  attachments?: GoatChatMessageAttachment[];
  attachmentTexts?: Record<string, string> | null;
}): Promise<GoatTask> {
  return createSharedGoatTaskFromWorkflow(input, {
    createTask: ({ actorId, ...task }) =>
      createGoatTaskForUser({
        ...task,
        userWorkosId: actorId,
        source: "workflow",
      }),
    resolveWorkflow: resolveGoatWorkflowMention,
    preparation: {
      isCodexConnected: isGoatCodexConnectedForUser,
      isClaudeCodeConnected: isGoatClaudeCodeConnectedForUser,
      resolveSkills: resolveGoatSkillMentions,
      getAvailableTools: getGoatAvailableHarnessTools,
    },
  });
}

// Chat- and trigger-created workflow tasks share this: the task is created instantly with the
// workflow name, then renamed to a cheap one-line summary of the request once generation lands.
export async function generateGoatWorkflowTaskTitle(input: {
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
    const title = await generateGoatChatTitle({
      content: input.description,
      fallbackTitle: input.workflowName,
      apiKey,
      userWorkosId: input.userWorkosId,
    });
    if (!title || title === input.workflowName) return;
    await updateGoatTaskForActor({
      actorId: input.userWorkosId,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      name: title,
    });
  } catch {
    // Keep the workflow-name fallback; a missing pretty title is not worth failing anything.
  }
}
