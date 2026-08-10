import { currentGoatUser } from "@/lib/auth";
import { continueGoatTaskAction } from "@/lib/tasks";

type RouteContext = {
  params: Promise<{ taskId: string }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  if (!(await currentGoatUser({ optional: true }))) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Invalid task continuation." }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  if (typeof input.prompt !== "string") {
    return Response.json({ error: "Invalid task continuation." }, { status: 400 });
  }
  if (input.clientMessageId !== undefined && typeof input.clientMessageId !== "string") {
    return Response.json({ error: "Invalid task continuation." }, { status: 400 });
  }

  const { taskId } = await params;
  const result = await continueGoatTaskAction(
    taskId,
    input.prompt,
    input.clientMessageId,
    input.mentions,
  );
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
