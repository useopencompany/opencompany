import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { createCodingWorkspaceRuntimeAccess } from "@/lib/codex-chat";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ chatSessionId: string }> },
) {
  const context = await currentUser({ optional: true });
  if (!context) return new Response("Unauthorized", { status: 401 });

  const { chatSessionId } = await params;
  const result = await createCodingWorkspaceRuntimeAccess({
    userWorkosId: context.user.workosUserId,
    chatSessionId,
  });
  if (!result.ok) return new Response(result.error, { status: result.statusCode });

  return NextResponse.json(result.access);
}
