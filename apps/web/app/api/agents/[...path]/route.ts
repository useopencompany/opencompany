import { NextResponse } from "next/server";
import { loadAgentForWorkspace } from "@/lib/agents/data";
import { currentWorkspace } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const idOrPath = path.map(decodeURIComponent).join("/");
  const { workspace } = await currentWorkspace();
  const agent = await loadAgentForWorkspace(workspace.id, idOrPath);

  if (!agent) {
    return NextResponse.json({ error: "Agent not found." }, { status: 404 });
  }

  return NextResponse.json({ agent });
}
