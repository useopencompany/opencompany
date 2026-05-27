import { NextResponse } from "next/server";
import { loadAgentsForWorkspace } from "@/lib/agents/data";
import { currentWorkspace } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const { workspace } = await currentWorkspace();
  const agents = await loadAgentsForWorkspace(workspace.id);

  return NextResponse.json({ agents });
}
