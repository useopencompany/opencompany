"use server";

import { recordBrainFileVersion } from "@opencompany/db/brain-versions";
import { getDb } from "@opencompany/db/client";
import { brainFiles, brainFileVersions } from "@opencompany/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentWorkspace } from "@/lib/auth";
import { updateBrainFile } from "@/lib/brain/actions";
import { normalizeBrainPath } from "@/lib/brain/paths";

// Version history + restore for the company Brain (PRO-244). The runner captures
// the prior content of every brain file before it overwrites/deletes it
// (brainFileVersions, scope="company", path=logical brainFiles.path, agentId
// null). These actions let the UI list those versions and roll a file back to
// any of them. A restore is itself recorded as a new version row, so it is just
// as undoable as the change it reverts.

// What the UI needs to render the version list — never the full content (which
// can be up to 256 KB per row); content is only loaded on restore.
export type BrainFileVersionSummary = {
  id: number;
  operation: string;
  sizeBytes: number;
  createdAt: string;
  sessionId: string | null;
};

type ListResult = { ok: true; versions: BrainFileVersionSummary[] } | { ok: false; error: string };

type RestoreResult = { ok: true; path: string } | { ok: false; error: string };

// List the saved versions for a single company Brain file, newest first.
export async function listBrainFileVersions(path: string): Promise<ListResult> {
  const { workspace } = await currentWorkspace();

  try {
    const normalized = normalizeBrainPath(path);
    const db = getDb();
    const rows = await db
      .select({
        id: brainFileVersions.id,
        operation: brainFileVersions.operation,
        sizeBytes: brainFileVersions.sizeBytes,
        createdAt: brainFileVersions.createdAt,
        sessionId: brainFileVersions.sessionId,
      })
      .from(brainFileVersions)
      .where(
        and(
          eq(brainFileVersions.workspaceId, workspace.id),
          eq(brainFileVersions.scope, "company"),
          eq(brainFileVersions.path, normalized),
        ),
      )
      .orderBy(desc(brainFileVersions.createdAt))
      .limit(50);

    const versions = rows.map((row) => ({
      id: row.id,
      operation: row.operation,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt.toISOString(),
      sessionId: row.sessionId,
    }));
    return { ok: true, versions };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to load versions.",
    };
  }
}

// Restore a company Brain file to a specific saved version. The current live
// content is first captured as a new version row (so the restore is undoable),
// then the file is upserted to the version's content through the same
// write/enqueue/dispatch path as a normal edit. A version whose `operation` was
// "delete" simply re-creates the file via upsert.
export async function restoreBrainFileVersion(input: {
  path: string;
  versionId: number;
}): Promise<RestoreResult> {
  const { workspace } = await currentWorkspace();

  try {
    const normalized = normalizeBrainPath(input.path);
    const db = getDb();

    const [version] = await db
      .select()
      .from(brainFileVersions)
      .where(
        and(
          eq(brainFileVersions.id, input.versionId),
          eq(brainFileVersions.workspaceId, workspace.id),
          eq(brainFileVersions.scope, "company"),
          eq(brainFileVersions.path, normalized),
        ),
      )
      .limit(1);
    if (!version) return { ok: false, error: "Version not found." };

    return await applyBrainRestore({ workspaceId: workspace.id, path: normalized, version });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Restore failed." };
  }
}

// "Step back a turn" for the company Brain: restore the single most-recent saved
// version for the file (no multi-file/session grouping).
export async function restoreLatestBrainVersionBeforeTurn(path: string): Promise<RestoreResult> {
  const { workspace } = await currentWorkspace();

  try {
    const normalized = normalizeBrainPath(path);
    const db = getDb();

    const [version] = await db
      .select()
      .from(brainFileVersions)
      .where(
        and(
          eq(brainFileVersions.workspaceId, workspace.id),
          eq(brainFileVersions.scope, "company"),
          eq(brainFileVersions.path, normalized),
        ),
      )
      .orderBy(desc(brainFileVersions.createdAt))
      .limit(1);
    if (!version) return { ok: false, error: "No previous version to restore." };

    return await applyBrainRestore({ workspaceId: workspace.id, path: normalized, version });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Restore failed." };
  }
}

// Shared restore body: snapshot the live content (unless it already matches the
// target), then write the version's content back through the normal edit path.
async function applyBrainRestore(input: {
  workspaceId: string;
  path: string;
  version: typeof brainFileVersions.$inferSelect;
}): Promise<RestoreResult> {
  const { workspaceId, path, version } = input;
  const db = getDb();

  const [current] = await db
    .select({
      content: brainFiles.content,
      contentHash: brainFiles.contentHash,
      sizeBytes: brainFiles.sizeBytes,
    })
    .from(brainFiles)
    .where(and(eq(brainFiles.workspaceId, workspaceId), eq(brainFiles.path, path)))
    .limit(1);

  // Capture the live content as a new version before we overwrite it, so the
  // restore is itself undoable. Skip when the file already matches the target
  // (nothing would change, so there is nothing to preserve).
  if (current && current.contentHash !== version.contentHash) {
    await recordBrainFileVersion(db, {
      workspaceId,
      scope: "company",
      agentId: null,
      path,
      content: current.content,
      contentHash: current.contentHash,
      sizeBytes: current.sizeBytes,
      operation: "overwrite",
      sessionId: null,
    });
  }

  // Reuse the standard edit path so the upsert, outbox enqueue, dispatch, and
  // revalidate all happen exactly as they would for a manual save.
  return await updateBrainFile(path, version.content);
}
