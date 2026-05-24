import { NextResponse } from "next/server";
import { loadAgentSessionDetailForWorkspace } from "@/lib/agent-sessions/data";
import { requireCurrentWorkspace } from "@/lib/auth";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, workspace } = await requireCurrentWorkspace();
  const detail = await loadAgentSessionDetailForWorkspace(id, user.id, workspace.id);

  if (!detail) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }

  return NextResponse.json({ detail });
}
