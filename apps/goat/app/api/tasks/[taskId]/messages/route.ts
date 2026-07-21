import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import { sendGoatTaskSteeringMessage } from "@/lib/task-steering";
import { GOAT_TASK_PROMPT_MAX_LENGTH } from "@/lib/task-validation";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response("Unauthorized", { status: 401 });
  if (!context.user.taskSpawningEnabled) {
    return new Response("Background tasks are disabled.", { status: 403 });
  }

  const { taskId } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body.", { status: 400 });
  }
  const prompt =
    body && typeof body === "object" && "prompt" in body && typeof body.prompt === "string"
      ? body.prompt.trim()
      : "";
  if (!prompt) return new Response("Message is required.", { status: 400 });
  if (prompt.length > GOAT_TASK_PROMPT_MAX_LENGTH) {
    return new Response("Message is too long.", { status: 400 });
  }

  const result = await sendGoatTaskSteeringMessage({
    userWorkosId: context.user.workosUserId,
    taskId,
    prompt,
  });
  if (!result.ok) return new Response(result.error, { status: result.status });
  return NextResponse.json({ ok: true, taskId: result.taskId, messageId: result.messageId });
}
