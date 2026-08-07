import { after, NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import {
  extractGoatChatAttachmentTexts,
  parseGoatChatAttachmentsInput,
} from "@/lib/chat-attachments";
import { GOAT_CHAT_PROMPT_MAX_LENGTH } from "@/lib/chat-validation";
import { TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { GoatSkillMentionError, readGoatSkillMentionRefs } from "@/lib/skills";
import { createGoatTaskFromWorkflow, generateGoatWorkflowTaskTitle } from "@/lib/workflow-tasks";
import {
  GoatWorkflowMentionError,
  listGoatWorkflowCatalog,
  readGoatWorkflowMentionRef,
} from "@/lib/workflows";

export async function GET() {
  const context = await currentGoatUser({ optional: true });
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!context.user.taskSpawningEnabled) {
    return NextResponse.json({ error: TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE }, { status: 403 });
  }

  const workflows = await listGoatWorkflowCatalog(context.workspace.id);
  return NextResponse.json({ workflows });
}

export async function POST(request: Request) {
  const context = await currentGoatUser({ optional: true });
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
  if (description.length > GOAT_CHAT_PROMPT_MAX_LENGTH) {
    return NextResponse.json(
      {
        error: `Workflow task descriptions can be at most ${GOAT_CHAT_PROMPT_MAX_LENGTH.toLocaleString()} characters.`,
      },
      { status: 400 },
    );
  }

  const parsedMention = readGoatWorkflowMentionRef([input.workflow]);
  if (!parsedMention.ok || !parsedMention.mention) {
    return NextResponse.json(
      { error: parsedMention.ok ? "A workflow is required." : parsedMention.error },
      { status: 400 },
    );
  }
  const parsedSkillMentions = readGoatSkillMentionRefs(input.mentions);
  if (!parsedSkillMentions.ok) {
    return NextResponse.json({ error: parsedSkillMentions.error }, { status: 400 });
  }
  const parsedAttachments = parseGoatChatAttachmentsInput(
    input.attachments,
    context.user.workosUserId,
  );
  if (!parsedAttachments.ok) {
    return NextResponse.json({ error: parsedAttachments.error }, { status: 400 });
  }
  const attachmentTexts =
    parsedAttachments.attachments.length > 0
      ? await extractGoatChatAttachmentTexts(parsedAttachments.attachments)
      : null;

  try {
    const task = await createGoatTaskFromWorkflow({
      userWorkosId: context.user.workosUserId,
      workspaceId: context.workspace.id,
      mention: parsedMention.mention,
      skillMentions: parsedSkillMentions.mentions,
      description,
      attachments: parsedAttachments.attachments,
      attachmentTexts,
    });
    after(
      generateGoatWorkflowTaskTitle({
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
    if (error instanceof GoatWorkflowMentionError || error instanceof GoatSkillMentionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
