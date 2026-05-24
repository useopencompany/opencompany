import { NextResponse } from "next/server";
import { loadAgentSessionDetailForWorkspace } from "@/lib/agent-sessions/data";
import { parseAgentSessionDetailPayload } from "@/lib/agent-sessions/payload";
import { requireCurrentWorkspace } from "@/lib/auth";

const SESSION_API_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, workspace } = await requireCurrentWorkspace();
  const detail = await loadAgentSessionDetailForWorkspace(id, user.id, workspace.id);

  if (!detail) {
    return NextResponse.json(
      { error: "Session not found." },
      { status: 404, headers: SESSION_API_HEADERS },
    );
  }

  return NextResponse.json(
    { detail: parseAgentSessionDetailPayload(detail) },
    { headers: SESSION_API_HEADERS },
  );
}
