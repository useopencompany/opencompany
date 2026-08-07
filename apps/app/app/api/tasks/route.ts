import { NextResponse } from "next/server";
import { descriptionFromGoatAdHocTaskPrompt } from "@/lib/ad-hoc-task";
import { currentGoatUser } from "@/lib/auth";
import { isGoatClaudeCodeConnectedForUser } from "@/lib/claude-code-auth";
import { isGoatCodexConnectedForUser } from "@/lib/codex-auth";
import { TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { validateGoatTaskInput } from "@/lib/task-validation";
import { createGoatTaskForUser } from "@/lib/tasks";

export async function POST(request: Request) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!context.user.taskSpawningEnabled) {
    return NextResponse.json({ error: TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid task request." }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  const parsed = validateGoatTaskInput({
    prompt:
      typeof input.description === "string"
        ? descriptionFromGoatAdHocTaskPrompt(input.description)
        : input.description,
    model: input.model,
  });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const engine =
    input.engine === "codex" || input.engine === "claude_code" ? input.engine : undefined;
  if (input.engine !== undefined && !engine) {
    return NextResponse.json({ error: "Invalid task engine." }, { status: 400 });
  }
  if (engine === "codex" && !(await isGoatCodexConnectedForUser(context.user.workosUserId))) {
    return NextResponse.json(
      { error: "Codex is not connected. Connect Codex in Settings first." },
      { status: 400 },
    );
  }
  if (
    engine === "claude_code" &&
    !(await isGoatClaudeCodeConnectedForUser(context.user.workosUserId))
  ) {
    return NextResponse.json(
      { error: "Claude Code is not connected. Connect Claude Code in Settings first." },
      { status: 400 },
    );
  }

  const task = await createGoatTaskForUser({
    userWorkosId: context.user.workosUserId,
    workspaceId: context.workspace.id,
    prompt: parsed.value.prompt,
    model: parsed.value.model,
    ...(engine ? { engine } : {}),
  });

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
}
