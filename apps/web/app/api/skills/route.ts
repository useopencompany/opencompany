import { NextResponse } from "next/server";
import { currentWorkspace } from "@/lib/auth";
import { listWorkspaceSkillSnapshots, toExternalSkillReference } from "@/lib/skills/snapshots";

export const dynamic = "force-dynamic";

// List the workspace's external skill catalog (for the editor mention suggestions). Persisting
// a skill is a mutation and lives in a Server Action (`saveSkill` in lib/skills/actions.ts).
export async function GET() {
  const { workspace } = await currentWorkspace();
  const snapshots = await listWorkspaceSkillSnapshots(workspace.id);
  return NextResponse.json({
    skills: snapshots.map((snapshot) => ({
      ...toExternalSkillReference(snapshot),
      command: snapshot.command,
      fileCount: snapshot.fileCount,
      totalBytes: snapshot.totalBytes,
      resolvedCommit: snapshot.resolvedCommit,
      lastResolvedAt: snapshot.lastResolvedAt,
    })),
  });
}
