import type { ChatMessageAttachment } from "@opencompany/agent/chat-attachment-formats";
import type { SkillMentionRef } from "@opencompany/agent/skills";
import { createTaskFromWorkflow as createSharedTaskFromWorkflow } from "@opencompany/agent/workflow-tasks";
import type { WorkflowMentionRef } from "@opencompany/agent/workflows";
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
