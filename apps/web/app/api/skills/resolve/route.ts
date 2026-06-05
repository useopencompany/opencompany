import { SkillResolverError } from "@opencompany/agent-runtime";
import { NextResponse } from "next/server";
import { currentWorkspace } from "@/lib/auth";
import { resolveWorkspaceSkill } from "@/lib/skills/resolver";

export const dynamic = "force-dynamic";

// Resolve + preview a skill source without persisting anything. Returns either the resolved
// skill (name, description, provenance, file list) or an ambiguous candidate list to choose from.
export async function POST(request: Request) {
  const { workspace } = await currentWorkspace();

  let body: { url?: unknown; selectedPath?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (typeof body.url !== "string" || !body.url.trim()) {
    return NextResponse.json({ error: "A skill URL is required." }, { status: 400 });
  }

  try {
    const result = await resolveWorkspaceSkill({
      url: body.url,
      workspaceId: workspace.id,
      ...(typeof body.selectedPath === "string" ? { selectedPath: body.selectedPath } : {}),
    });
    if (result.status === "ambiguous") {
      return NextResponse.json({ status: "ambiguous", candidates: result.candidates });
    }
    const { files, ...skill } = result.skill;
    return NextResponse.json({
      status: "resolved",
      skill: { ...skill, files: files.map((file) => ({ path: file.path })) },
    });
  } catch (error) {
    if (error instanceof SkillResolverError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json(
      { error: "Couldn't resolve that skill. Check the URL and try again." },
      { status: 502 },
    );
  }
}
