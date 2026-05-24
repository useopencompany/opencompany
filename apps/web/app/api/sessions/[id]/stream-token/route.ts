import { NextResponse } from "next/server";
import { loadAgentSessionStreamCredentialForWorkspace } from "@/lib/agent-sessions/data";
import { parseSessionStreamCredentialResponse } from "@/lib/agent-sessions/payload";
import { requireCurrentWorkspace } from "@/lib/auth";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, workspace } = await requireCurrentWorkspace();
  const credential = await loadAgentSessionStreamCredentialForWorkspace(id, user.id, workspace.id);

  if (!credential) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }

  return NextResponse.json(parseSessionStreamCredentialResponse(credential));
}
