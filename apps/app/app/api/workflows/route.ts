import { after, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { extractChatAttachmentTexts, parseChatAttachmentsInput } from "@/lib/chat-attachments";
import { CHAT_PROMPT_MAX_LENGTH } from "@/lib/chat-validation";
import { TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { SkillMentionError } from "@/lib/skills";
import { createTaskFromWorkflow, generateWorkflowTaskTitle } from "@/lib/workflow-tasks";
import { listWorkflowCatalog, readWorkflowMentionRef, WorkflowMentionError } from "@/lib/workflows";

export async function GET() {
  const context = await currentUser({ optional: true });
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!context.user.taskSpawningEnabled) {
    return NextResponse.json({ error: TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE }, { status: 403 });
  }

  const workflows = await listWorkflowCatalog(context.workspace.id);
  return NextResponse.json({ workflows });
}

export async function POST(request: Request) {
  const context = await currentUser({ optional: true });
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!context.user.taskSpawningEnabled) {
    return NextResponse.json({ error: TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid workflow task request." }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  if (typeof input.description !== "string") {
    return NextResponse.json(
      { error: "A workflow task description is required." },
      { status: 400 },
    );
  }
  const description = input.description.trim();
  if (!description) {
    return NextResponse.json(
      { error: "A workflow task description is required." },
      { status: 400 },
    );
  }
  if (description.length > CHAT_PROMPT_MAX_LENGTH) {
    return NextResponse.json(
      {
        error: `Workflow task descriptions can be at most ${CHAT_PROMPT_MAX_LENGTH.toLocaleString()} characters.`,
      },
      { status: 400 },
    );
  }

  const parsedMention = readWorkflowMentionRef([input.workflow]);
  if (!parsedMention.ok || !parsedMention.mention) {
    return NextResponse.json(
      { error: parsedMention.ok ? "A workflow is required." : parsedMention.error },
      { status: 400 },
    );
  }
  const parsedAttachments = parseChatAttachmentsInput(input.attachments, context.user.workosUserId);
  if (!parsedAttachments.ok) {
    return NextResponse.json({ error: parsedAttachments.error }, { status: 400 });
  }
  const attachmentTexts =
    parsedAttachments.attachments.length > 0
      ? await extractChatAttachmentTexts(parsedAttachments.attachments)
      : null;

  try {
    const task = await createTaskFromWorkflow({
      userWorkosId: context.user.workosUserId,
      workspaceId: context.workspace.id,
      mention: parsedMention.mention,
      description,
      attachments: parsedAttachments.attachments,
      attachmentTexts,
    });
    after(
      generateWorkflowTaskTitle({
        taskId: task.id,
        userWorkosId: context.user.workosUserId,
        workflowName: task.name,
        description,
        apiKey: process.env.VERCEL_AI_GATEWAY_API_KEY ?? null,
      }).catch(() => undefined),
    );

    return NextResponse.json(
      {
        task: {
          id: task.id,
          displayId: task.displayId,
          name: task.name,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof WorkflowMentionError || error instanceof SkillMentionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
