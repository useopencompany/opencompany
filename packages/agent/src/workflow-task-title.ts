import { generateChatTitle } from "./chat-title";

export async function refineWorkflowTaskTitle<T>(
  input: {
    taskId: string;
    conversationId: string;
    workflowName: string;
    description: string;
    apiKey?: string;
    actorId: string;
  },
  dependencies: {
    updateTaskName: (name: string) => Promise<T>;
    generateTitle?: typeof generateChatTitle;
  },
): Promise<T | null> {
  if (!input.apiKey?.trim()) return null;

  try {
    const title = await (dependencies.generateTitle ?? generateChatTitle)({
      content: input.description,
      fallbackTitle: input.workflowName,
      apiKey: input.apiKey,
      userWorkosId: input.actorId,
      chatSessionId: input.conversationId,
    });
    if (!title || title === input.workflowName) return null;
    return await dependencies.updateTaskName(title);
  } catch (error) {
    console.warn("Workflow Task title refinement failed.", {
      event: "opencompany.workflow_task_title_failed",
      task_id: input.taskId,
      error,
    });
    return null;
  }
}
