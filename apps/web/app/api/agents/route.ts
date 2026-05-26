import { NextResponse } from "next/server";
import { loadAgentsForWorkspace } from "@/lib/agents/data";
import { requireCurrentWorkspace } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const { workspace } = await requireCurrentWorkspace();
  const agents = await loadAgentsForWorkspace(workspace.id);

  return NextResponse.json({ agents });
}
