"use server";

import { getDb } from "@opencompany/db/client";
import { agents, workspaceSkillSnapshots, workspaceSkills } from "@opencompany/db/schema";
import { enqueueWorkspaceSync } from "@opencompany/db/sync-outbox";
import { and, asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentWorkspace } from "@/lib/auth";
import {
  agentReferencesWorkspaceSkill,
  baseWorkspaceSkillId,
  nextWorkspaceSkillId,
  serializeWorkspaceSkill,
  type WorkspaceSkillPayload,
  workspaceSkillPayload,
  workspaceSkillRepoPath,
} from "@/lib/skills/workspace";
import { scheduleWorkspaceSyncDispatch } from "@/lib/workspace-state/sync-dispatch";

type WorkspaceSkillActionResult =
  | { ok: true; skill: WorkspaceSkillPayload }
  | { ok: false; error: string; references?: string[] };

type DeleteWorkspaceSkillResult =
  | { ok: true; skillId: string }
  | { ok: false; error: string; references?: string[] };

export async function listWorkspaceSkills(): Promise<WorkspaceSkillPayload[]> {
  const { workspace } = await currentWorkspace();
  const rows = await getDb()
    .select()
    .from(workspaceSkills)
    .where(eq(workspaceSkills.workspaceId, workspace.id))
    .orderBy(asc(workspaceSkills.name), asc(workspaceSkills.skillId));
  return rows.map(workspaceSkillPayload);
}

export async function createWorkspaceSkill(input: {
  name: string;
  description: string;
  body: string;
}): Promise<WorkspaceSkillActionResult> {
  const { workspace } = await currentWorkspace();
  const serialized = serializeWorkspaceSkill(input);
  if (!serialized.ok) return serialized;

  const db = getDb();
  const [skillRows, snapshotRows] = await Promise.all([
    db
      .select({ skillId: workspaceSkills.skillId })
      .from(workspaceSkills)
      .where(eq(workspaceSkills.workspaceId, workspace.id)),
    db
      .select({ skillId: workspaceSkillSnapshots.skillId })
      .from(workspaceSkillSnapshots)
      .where(eq(workspaceSkillSnapshots.workspaceId, workspace.id)),
  ]);
  const reserved = new Set([
    ...skillRows.map((row) => row.skillId),
    ...snapshotRows.map((row) => row.skillId),
  ]);
  const skillId = nextWorkspaceSkillId(baseWorkspaceSkillId(serialized.name), reserved);
  const now = new Date();
  const repoPath = workspaceSkillRepoPath(skillId);

  const [inserted] = await db.batch([
    db
      .insert(workspaceSkills)
      .values({
        workspaceId: workspace.id,
        skillId,
        name: serialized.name,
        description: serialized.description,
        body: serialized.body,
        content: serialized.content,
        contentHash: serialized.contentHash,
        sizeBytes: serialized.sizeBytes,
        githubSyncStatus: "pending",
        githubSyncError: null,
        updatedAt: now,
      })
      .returning(),
    enqueueWorkspaceSync(db, {
      workspaceId: workspace.id,
      repoPath,
      sourceKind: "skill",
      sourceRef: skillId,
      operation: "upsert",
      desiredHash: serialized.contentHash,
    }),
  ]);
  const row = inserted[0];
  if (!row) return { ok: false, error: "Could not create skill." };

  scheduleWorkspaceSyncDispatch({ workspaceId: workspace.id });
  revalidatePath("/company/skills");
  return { ok: true, skill: workspaceSkillPayload(row) };
}

export async function updateWorkspaceSkill(
  skillId: string,
  input: { name: string; description: string; body: string },
): Promise<WorkspaceSkillActionResult> {
  const { workspace } = await currentWorkspace();
  const serialized = serializeWorkspaceSkill(input);
  if (!serialized.ok) return serialized;

  const db = getDb();
  const now = new Date();
  const [existing] = await db
    .select({ skillId: workspaceSkills.skillId })
    .from(workspaceSkills)
    .where(and(eq(workspaceSkills.workspaceId, workspace.id), eq(workspaceSkills.skillId, skillId)))
    .limit(1);
  if (!existing) return { ok: false, error: "Skill not found." };
  const [updated] = await db.batch([
    db
      .update(workspaceSkills)
      .set({
        name: serialized.name,
        description: serialized.description,
        body: serialized.body,
        content: serialized.content,
        contentHash: serialized.contentHash,
        sizeBytes: serialized.sizeBytes,
        githubSyncStatus: "pending",
        githubSyncError: null,
        updatedAt: now,
      })
      .where(
        and(eq(workspaceSkills.workspaceId, workspace.id), eq(workspaceSkills.skillId, skillId)),
      )
      .returning(),
    enqueueWorkspaceSync(db, {
      workspaceId: workspace.id,
      repoPath: workspaceSkillRepoPath(skillId),
      sourceKind: "skill",
      sourceRef: skillId,
      operation: "upsert",
      desiredHash: serialized.contentHash,
    }),
  ]);
  const row = updated[0];
  if (!row) return { ok: false, error: "Skill not found." };

  scheduleWorkspaceSyncDispatch({ workspaceId: workspace.id });
  revalidatePath("/company/skills");
  return { ok: true, skill: workspaceSkillPayload(row) };
}

export async function deleteWorkspaceSkill(skillId: string): Promise<DeleteWorkspaceSkillResult> {
  const { workspace } = await currentWorkspace();
  const db = getDb();
  const [skill] = await db
    .select()
    .from(workspaceSkills)
    .where(and(eq(workspaceSkills.workspaceId, workspace.id), eq(workspaceSkills.skillId, skillId)))
    .limit(1);
  if (!skill) return { ok: false, error: "Skill not found." };

  const agentRows = await db
    .select({ name: agents.name, body: agents.body, config: agents.config })
    .from(agents)
    .where(eq(agents.workspaceId, workspace.id))
    .orderBy(asc(agents.name));
  const references = agentRows
    .filter((agent) =>
      agentReferencesWorkspaceSkill({ body: agent.body, config: agent.config, skillId }),
    )
    .map((agent) => agent.name);
  if (references.length > 0) {
    return {
      ok: false,
      error: "Remove this skill from agents before deleting it.",
      references,
    };
  }

  await db.batch([
    db
      .delete(workspaceSkills)
      .where(
        and(eq(workspaceSkills.workspaceId, workspace.id), eq(workspaceSkills.skillId, skillId)),
      ),
    enqueueWorkspaceSync(db, {
      workspaceId: workspace.id,
      repoPath: workspaceSkillRepoPath(skillId),
      sourceKind: "skill",
      sourceRef: skillId,
      operation: "delete",
      desiredHash: null,
      previousBlobSha: skill.githubBlobSha,
    }),
  ]);

  scheduleWorkspaceSyncDispatch({ workspaceId: workspace.id });
  revalidatePath("/company/skills");
  return { ok: true, skillId };
}
