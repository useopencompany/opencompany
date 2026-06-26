import {
  type AgentExternalSkillReference,
  type AgentRemoteSkillSource,
  type AgentSkillFile,
  createGitHubSkillFetcher,
  parseSkillUrl,
  type ResolvedSkill,
  resolveSkill,
} from "@opencompany/agent-runtime";
import { workspaceSkillSnapshots } from "@opencompany/db/schema";
import { createLogger } from "@opencompany/observability";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";

const logger = createLogger({ service: "opencompany-runner", runtime: "server" });

// How long a snapshot is trusted before we re-check the branch HEAD. Keeps "track latest"
// honest without an API call on every single session start.
const SNAPSHOT_FRESHNESS_MS = 5 * 60 * 1000;

export type MaterializableSkill = { id: string; files: AgentSkillFile[] };
type RemoteSkillReference = AgentExternalSkillReference & { source: AgentRemoteSkillSource };

function newSkillSnapshotId() {
  return `skl_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

// Load the files for the workspace's external skills, refreshing each to its branch HEAD.
// Resolution happens here in the trusted runner host (never in the sandbox); the caller then
// materializes the returned files read-only. A skill that can't be resolved and has no cached
// snapshot is skipped (warned) so it never blocks session start.
export async function loadExternalSkillFiles(
  workspaceId: string,
  refs: RemoteSkillReference[],
): Promise<MaterializableSkill[]> {
  const out: MaterializableSkill[] = [];
  for (const ref of refs) {
    const skill = await loadExternalSkill(workspaceId, ref);
    if (skill) out.push(skill);
  }
  return out;
}

async function loadExternalSkill(
  workspaceId: string,
  ref: RemoteSkillReference,
): Promise<MaterializableSkill | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(workspaceSkillSnapshots)
    .where(
      and(
        eq(workspaceSkillSnapshots.workspaceId, workspaceId),
        eq(workspaceSkillSnapshots.sourceUrl, ref.source.url),
        eq(workspaceSkillSnapshots.requestedRef, ref.source.ref),
        eq(workspaceSkillSnapshots.skillPath, ref.source.path),
      ),
    )
    .limit(1);

  const now = Date.now();
  if (row && now - row.lastResolvedAt.getTime() < SNAPSHOT_FRESHNESS_MS) {
    return { id: ref.id, files: row.files };
  }

  try {
    const fetcher = createGitHubSkillFetcher();
    const { owner, repo } = parseSkillUrl(ref.source.url);
    const head = await fetcher.resolveCommit(owner, repo, ref.source.ref);

    // HEAD unchanged: reuse the cached files, just bump the freshness timestamp.
    if (row && head && head === row.resolvedCommit) {
      await db
        .update(workspaceSkillSnapshots)
        .set({ lastResolvedAt: new Date(), updatedAt: new Date() })
        .where(eq(workspaceSkillSnapshots.id, row.id));
      return { id: ref.id, files: row.files };
    }

    // Changed (or never snapshotted): re-resolve the skill folder and refresh the cache.
    const result = await resolveSkill({
      url: `${ref.source.url}#${ref.source.ref}`,
      fetcher,
      selectedPath: ref.source.path,
    });
    if (result.status !== "resolved") {
      throw new Error("skill source is ambiguous");
    }
    await upsertSnapshot(workspaceId, ref, result.skill);
    return { id: ref.id, files: result.skill.files };
  } catch (error) {
    logger.warn("External skill refresh failed; using cached snapshot if available", {
      event: "opencompany.runner_external_skill_refresh_failed",
      workspace_id: workspaceId,
      skill_id: ref.id,
      source_url: ref.source.url,
      error: error instanceof Error ? error.message : String(error),
    });
    if (row) return { id: ref.id, files: row.files };
    logger.warn("External skill has no cached snapshot; skipping", {
      event: "opencompany.runner_external_skill_skipped",
      workspace_id: workspaceId,
      skill_id: ref.id,
      source_url: ref.source.url,
    });
    return null;
  }
}

async function upsertSnapshot(
  workspaceId: string,
  ref: RemoteSkillReference,
  resolved: ResolvedSkill,
) {
  const db = getDb();
  const now = new Date();
  await db
    .insert(workspaceSkillSnapshots)
    .values({
      id: newSkillSnapshotId(),
      workspaceId,
      // Keep the mount id stable: it's pinned in the agent's config, not re-slugged here.
      skillId: ref.id,
      name: resolved.name,
      description: resolved.description,
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
      set: {
        // Realign the persisted mount id with the ref the session is materializing under, so
        // anything that rebuilds refs from skill_id can't resurrect a stale mount id.
        skillId: ref.id,
        name: resolved.name,
        description: resolved.description,
        resolvedCommit: resolved.resolvedCommit,
        integrity: resolved.integrity,
        files: resolved.files,
        fileCount: resolved.fileCount,
        totalBytes: resolved.totalBytes,
        lastResolvedAt: now,
        updatedAt: now,
      },
    });
}
