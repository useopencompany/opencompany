import { getDb } from "@opencompany/db/client";
import { workspaceSkills } from "@opencompany/db/schema";
import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { currentWorkspace } from "@/lib/auth";
import { listWorkspaceSkillSnapshots, toExternalSkillReference } from "@/lib/skills/snapshots";
import { toWorkspaceSkillReference } from "@/lib/skills/workspace";

export const dynamic = "force-dynamic";

// List the workspace skill catalog (for editor mention suggestions). Persisting remote
// skill snapshots and authored workspace skills lives in Server Actions.
export async function GET() {
  const { workspace } = await currentWorkspace();
  const db = getDb();
  const [snapshots, authoredSkills] = await Promise.all([
    listWorkspaceSkillSnapshots(workspace.id),
    db
      .select()
      .from(workspaceSkills)
      .where(eq(workspaceSkills.workspaceId, workspace.id))
      .orderBy(asc(workspaceSkills.name), asc(workspaceSkills.skillId)),
  ]);
  return NextResponse.json({
    skills: [
      ...snapshots.map((snapshot) => ({
        ...toExternalSkillReference(snapshot),
        command: snapshot.command,
        fileCount: snapshot.fileCount,
        totalBytes: snapshot.totalBytes,
        resolvedCommit: snapshot.resolvedCommit,
        lastResolvedAt: snapshot.lastResolvedAt,
      })),
      ...authoredSkills.map((skill) => ({
        ...toWorkspaceSkillReference(skill),
        fileCount: 1,
        totalBytes: skill.sizeBytes,
        updatedAt: skill.updatedAt,
      })),
    ],
  });
}
