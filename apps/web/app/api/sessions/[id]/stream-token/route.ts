import { NextResponse } from "next/server";
import { loadAgentSessionStreamCredentialForWorkspace } from "@/lib/agent-sessions/data";
import { parseSessionStreamCredentialResponse } from "@/lib/agent-sessions/payload";
import { currentWorkspace } from "@/lib/auth";

const SESSION_API_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, workspace } = await currentWorkspace();
  const credential = await loadAgentSessionStreamCredentialForWorkspace(id, user.id, workspace.id);

  if (!credential) {
    return NextResponse.json(
      { error: "Session not found." },
      { status: 404, headers: SESSION_API_HEADERS },
    );
  }

  return NextResponse.json(parseSessionStreamCredentialResponse(credential), {
    headers: SESSION_API_HEADERS,
  });
}
