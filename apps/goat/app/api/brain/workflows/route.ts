import { after, NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import { GoatBrainSkillMentionError } from "@/lib/brain-skills";
import {
  GoatBrainWorkflowMentionError,
  listGoatBrainWorkflowCatalog,
  readGoatBrainWorkflowMentionRef,
} from "@/lib/brain-workflows";
import { GOAT_CHAT_PROMPT_MAX_LENGTH } from "@/lib/chat-validation";
import { createGoatTaskFromWorkflow, generateGoatWorkflowTaskTitle } from "@/lib/workflow-tasks";

export async function GET() {
  const context = await currentGoatUser({ optional: true });
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!context.activeBrain) return NextResponse.json({ workflows: [] });

  const workflows = await listGoatBrainWorkflowCatalog(context.activeBrain.id);
  return NextResponse.json({ workflows });
}

export async function POST(request: Request) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  const parsedMention = readGoatBrainWorkflowMentionRef([input.workflow]);
  if (!parsedMention.ok || !parsedMention.mention) {
    return NextResponse.json(
      { error: parsedMention.ok ? "A workflow is required." : parsedMention.error },
      { status: 400 },
    );
  }

  try {
    const task = await createGoatTaskFromWorkflow({
      userWorkosId: context.user.workosUserId,
      activeBrainRef: context.activeBrain?.id ?? null,
      mention: parsedMention.mention,
      description,
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
    if (
      error instanceof GoatBrainWorkflowMentionError ||
      error instanceof GoatBrainSkillMentionError
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
