import type { AgentExternalSkillReference, ResolvedSkill } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { workspaceSkillSnapshots } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";

export type WorkspaceSkillSnapshot = typeof workspaceSkillSnapshots.$inferSelect;

function newSkillSnapshotId() {
  return `skl_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export async function listWorkspaceSkillSnapshots(
  workspaceId: string,
): Promise<WorkspaceSkillSnapshot[]> {
  const db = getDb();
  return db
    .select()
    .from(workspaceSkillSnapshots)
    .where(eq(workspaceSkillSnapshots.workspaceId, workspaceId));
}

// The external-skill reference (frontmatter shape) for a stored snapshot. The runtime carries
// only provenance + denormalized name/description; the files live in the snapshot row.
export function toExternalSkillReference(
  snapshot: Pick<
    WorkspaceSkillSnapshot,
    "skillId" | "name" | "description" | "sourceType" | "sourceUrl" | "requestedRef" | "skillPath"
  >,
): AgentExternalSkillReference {
  return {
    id: snapshot.skillId,
    name: snapshot.name,
    description: snapshot.description,
    source: {
      type: snapshot.sourceType === "skills.sh" ? "skills.sh" : "github",
      url: snapshot.sourceUrl,
      ref: snapshot.requestedRef,
      path: snapshot.skillPath,
    },
  };
}

// Persist a resolved skill into the workspace catalog. Upserts on (workspace, source, ref,
// path): re-adding the same source refreshes the row in place and keeps its mount id stable.
export async function saveSkillSnapshot(
  workspaceId: string,
  resolved: ResolvedSkill,
): Promise<WorkspaceSkillSnapshot> {
  const db = getDb();
  const now = new Date();
  const [row] = await db
    .insert(workspaceSkillSnapshots)
    .values({
      id: newSkillSnapshotId(),
      workspaceId,
      skillId: resolved.skillId,
      name: resolved.name,
      description: resolved.description,
      command: resolved.command ?? null,
      sourceType: resolved.source.type,
      sourceUrl: resolved.source.url,
      requestedRef: resolved.source.ref,
      skillPath: resolved.source.path,
      resolvedCommit: resolved.resolvedCommit,
      integrity: resolved.integrity,
      files: resolved.files,
      fileCount: resolved.fileCount,
      totalBytes: resolved.totalBytes,
      lastResolvedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        workspaceSkillSnapshots.workspaceId,
        workspaceSkillSnapshots.sourceUrl,
        workspaceSkillSnapshots.requestedRef,
        workspaceSkillSnapshots.skillPath,
      ],
      // Keep id and skillId stable across refreshes; update the volatile snapshot fields.
      set: {
        name: resolved.name,
        description: resolved.description,
        command: resolved.command ?? null,
        resolvedCommit: resolved.resolvedCommit,
        integrity: resolved.integrity,
        files: resolved.files,
        fileCount: resolved.fileCount,
        totalBytes: resolved.totalBytes,
        lastResolvedAt: now,
        updatedAt: now,
      },
    })
    .returning();
  return row!;
}

// Find an existing snapshot matching a resolved source, so a re-add reuses its mount id.
export function findSnapshotForSource(
  snapshots: WorkspaceSkillSnapshot[],
  source: ResolvedSkill["source"],
): WorkspaceSkillSnapshot | undefined {
  return snapshots.find(
    (snapshot) =>
      snapshot.sourceUrl === source.url &&
      snapshot.requestedRef === source.ref &&
      snapshot.skillPath === source.path,
  );
}

export async function getWorkspaceSkillSnapshot(
  workspaceId: string,
  skillId: string,
): Promise<WorkspaceSkillSnapshot | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(workspaceSkillSnapshots)
    .where(
      and(
        eq(workspaceSkillSnapshots.workspaceId, workspaceId),
        eq(workspaceSkillSnapshots.skillId, skillId),
      ),
    )
    .limit(1);
  return row ?? null;
}
