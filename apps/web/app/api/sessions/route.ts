import { NextResponse } from "next/server";
import { loadSidebarSessionsForWorkspace } from "@/lib/agent-sessions/data";
import { parseSidebarSessionPayload } from "@/lib/agent-sessions/payload";
import { currentWorkspace } from "@/lib/auth";

const SESSION_API_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function GET() {
  const { user, workspace } = await currentWorkspace();
  const sessions = await loadSidebarSessionsForWorkspace(user.id, workspace.id);

  return NextResponse.json(
    { sessions: sessions.map(parseSidebarSessionPayload) },
    { headers: SESSION_API_HEADERS },
  );
}
