import { SkillResolverError } from "@opencompany/agent-runtime";
import { NextResponse } from "next/server";
import { currentWorkspace } from "@/lib/auth";
import { resolveWorkspaceSkill } from "@/lib/skills/resolver";
import {
  listWorkspaceSkillSnapshots,
  saveSkillSnapshot,
  toExternalSkillReference,
} from "@/lib/skills/snapshots";

export const dynamic = "force-dynamic";

// List the workspace's external skill catalog (for the editor mention suggestions).
export async function GET() {
  const { workspace } = await currentWorkspace();
  const snapshots = await listWorkspaceSkillSnapshots(workspace.id);
  return NextResponse.json({
    skills: snapshots.map((snapshot) => ({
      ...toExternalSkillReference(snapshot),
      fileCount: snapshot.fileCount,
      totalBytes: snapshot.totalBytes,
      resolvedCommit: snapshot.resolvedCommit,
      lastResolvedAt: snapshot.lastResolvedAt,
    })),
  });
}

// Resolve a skill source and persist it into the workspace catalog. Returns the external
// reference the editor inserts as @skill/<id>, or an ambiguous candidate list to choose from.
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
    const snapshot = await saveSkillSnapshot(workspace.id, result.skill);
    return NextResponse.json({ status: "saved", skill: toExternalSkillReference(snapshot) });
  } catch (error) {
    if (error instanceof SkillResolverError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json(
      { error: "Couldn't add that skill. Check the URL and try again." },
      { status: 502 },
    );
  }
}
