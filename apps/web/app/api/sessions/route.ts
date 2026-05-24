import { NextResponse } from "next/server";
import { loadSidebarSessionsForWorkspace } from "@/lib/agent-sessions/data";
import { parseSidebarSessionPayload } from "@/lib/agent-sessions/payload";
import { requireCurrentWorkspace } from "@/lib/auth";

export async function GET() {
  const { user, workspace } = await requireCurrentWorkspace();
  const sessions = await loadSidebarSessionsForWorkspace(user.id, workspace.id);

  return NextResponse.json({ sessions: sessions.map(parseSidebarSessionPayload) });
}
