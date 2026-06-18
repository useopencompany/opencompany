"use server";

import { recordBrainFileVersion } from "@opencompany/db/brain-versions";
import { getDb } from "@opencompany/db/client";
import { agentFiles, brainFileVersions } from "@opencompany/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { brainContentSize, hashBrainContent } from "@/lib/brain/hash";
import { isBrainTextFile, MAX_BRAIN_FILE_BYTES, normalizeBrainPath } from "@/lib/brain/paths";
import {
  personalBrainPrefix,
  personalBrainRepoPath,
  requirePersonalAgentRef,
} from "@/lib/personal/brain";

// Personal Brain CRUD. Mirrors lib/brain/actions.ts but writes to the personal agent's bundle
// (agent_files) under personal-brain/, scoped per (workspaceId, agentId). These edits are
// LOCAL-ONLY — like the personal agent itself, they are never enqueued to the workspace sync outbox
// and never projected to GitHub (githubSyncStatus stays "synced", nothing to sync).
type BrainActionResult = { ok: true; path: string } | { ok: false; error: string };

function normalizeFolderPath(path: string) {
  return normalizeBrainPath(`${path.replace(/\/+$/g, "")}/`, { allowFolder: true }).replace(
    /\/$/g,
    "",
  );
}

export async function createPersonalBrainFile(
  path: string,
  content = "",
): Promise<BrainActionResult> {
  return upsertPersonalBrainFile({ path, content, createOnly: true });
}

export async function updatePersonalBrainFile(
  path: string,
  content: string,
): Promise<BrainActionResult> {
  return upsertPersonalBrainFile({ path, content, createOnly: false });
}

async function upsertPersonalBrainFile(input: {
  path: string;
  content: string;
  createOnly: boolean;
}): Promise<BrainActionResult> {
  try {
    const ref = await requirePersonalAgentRef();
    const logicalPath = normalizeBrainPath(input.path);
    if (!isBrainTextFile(logicalPath)) {
      return { ok: false, error: "Only text files are supported in Personal Brain." };
    }
    const sizeBytes = brainContentSize(input.content);
    if (sizeBytes > MAX_BRAIN_FILE_BYTES) {
      return { ok: false, error: "Personal Brain files must be 256 KB or smaller." };
    }

    const db = getDb();
    const repoPath = personalBrainRepoPath(ref.bundleDir, logicalPath);
    const contentHash = hashBrainContent(input.content);
    const now = new Date();

    if (input.createOnly) {
      const [existing] = await db
        .select({ path: agentFiles.path })
        .from(agentFiles)
        .where(and(eq(agentFiles.workspaceId, ref.workspaceId), eq(agentFiles.path, repoPath)))
        .limit(1);
      if (existing) {
        return { ok: false, error: "A Personal Brain file already exists at this path." };
      }
    }

    const insert = db.insert(agentFiles).values({
      workspaceId: ref.workspaceId,
      agentId: ref.agentId,
      path: repoPath,
      content: input.content,
      contentHash,
      sizeBytes,
      githubSyncStatus: "synced",
      githubSyncError: null,
      updatedAt: now,
    });
    await (input.createOnly
      ? insert
      : insert.onConflictDoUpdate({
          target: [agentFiles.workspaceId, agentFiles.path],
          set: {
            agentId: ref.agentId,
            content: input.content,
            contentHash,
            sizeBytes,
            githubSyncStatus: "synced",
            githubSyncError: null,
            updatedAt: now,
          },
        }));

    revalidatePath("/personal/brain");
    return { ok: true, path: logicalPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Save failed." };
  }
}

export async function renamePersonalBrainFile(
  fromPath: string,
  toPath: string,
): Promise<BrainActionResult> {
  try {
    const ref = await requirePersonalAgentRef();
    const from = normalizeBrainPath(fromPath);
    const to = normalizeBrainPath(toPath);
    if (from === to) return { ok: true, path: to };

    const db = getDb();
    const fromRepo = personalBrainRepoPath(ref.bundleDir, from);
    const toRepo = personalBrainRepoPath(ref.bundleDir, to);

    const [existing] = await db
      .select()
      .from(agentFiles)
      .where(and(eq(agentFiles.workspaceId, ref.workspaceId), eq(agentFiles.path, fromRepo)))
      .limit(1);
    if (!existing) return { ok: false, error: "Personal Brain file not found." };

    const [destination] = await db
      .select({ path: agentFiles.path })
      .from(agentFiles)
      .where(and(eq(agentFiles.workspaceId, ref.workspaceId), eq(agentFiles.path, toRepo)))
      .limit(1);
    if (destination) {
      return { ok: false, error: "A Personal Brain file already exists at that path." };
    }

    await db
      .update(agentFiles)
      .set({ path: toRepo, updatedAt: new Date() })
      .where(and(eq(agentFiles.workspaceId, ref.workspaceId), eq(agentFiles.path, fromRepo)));

    revalidatePath("/personal/brain");
    return { ok: true, path: to };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Rename failed." };
  }
}

export async function renamePersonalBrainFolder(
  fromPath: string,
  toPath: string,
): Promise<BrainActionResult> {
  try {
    const ref = await requirePersonalAgentRef();
    const from = normalizeFolderPath(fromPath);
    const to = normalizeFolderPath(toPath);
    if (from === to) return { ok: true, path: to };
    if (to.startsWith(`${from}/`)) {
      return { ok: false, error: "Folders cannot be moved inside themselves." };
    }

    const db = getDb();
    const prefix = personalBrainPrefix(ref.bundleDir);
    const rows = await db
      .select()
      .from(agentFiles)
      .where(and(eq(agentFiles.workspaceId, ref.workspaceId), eq(agentFiles.agentId, ref.agentId)));
    const brainRows = rows.filter((row) => row.path.startsWith(prefix));
    const logicalByPath = new Map(
      brainRows.map((row) => [row.path, row.path.slice(prefix.length)]),
    );

    const moving = brainRows.filter((row) => logicalByPath.get(row.path)?.startsWith(`${from}/`));
    if (moving.length === 0) return { ok: false, error: "Personal Brain folder not found." };

    const existingLogical = new Set(logicalByPath.values());
    const movingLogical = new Set(moving.map((row) => logicalByPath.get(row.path)));
    for (const row of moving) {
      const logical = logicalByPath.get(row.path) as string;
      const nextLogical = `${to}/${logical.slice(from.length + 1)}`;
      if (existingLogical.has(nextLogical) && !movingLogical.has(nextLogical)) {
        return { ok: false, error: `A Personal Brain file already exists at ${nextLogical}.` };
      }
    }

    const now = new Date();
    const updates = moving.map((row) => {
      const logical = logicalByPath.get(row.path) as string;
      const nextRepo = personalBrainRepoPath(
        ref.bundleDir,
        `${to}/${logical.slice(from.length + 1)}`,
      );
      return db
        .update(agentFiles)
        .set({ path: nextRepo, updatedAt: now })
        .where(and(eq(agentFiles.workspaceId, ref.workspaceId), eq(agentFiles.path, row.path)));
    });
    const firstUpdate = updates[0];
    if (!firstUpdate) return { ok: false, error: "Personal Brain folder not found." };
    await db.batch([firstUpdate, ...updates.slice(1)]);

    revalidatePath("/personal/brain");
    return { ok: true, path: to };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Move failed." };
  }
}

export async function deletePersonalBrainFile(path: string): Promise<BrainActionResult> {
  try {
    const ref = await requirePersonalAgentRef();
    const logical = normalizeBrainPath(path);
    const repoPath = personalBrainRepoPath(ref.bundleDir, logical);
    await getDb()
      .delete(agentFiles)
      .where(and(eq(agentFiles.workspaceId, ref.workspaceId), eq(agentFiles.path, repoPath)));
    revalidatePath("/personal/brain");
    return { ok: true, path: logical };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Delete failed." };
  }
}

export async function deletePersonalBrainFolder(path: string): Promise<BrainActionResult> {
  try {
    const ref = await requirePersonalAgentRef();
    const folderPath = normalizeFolderPath(path);
    const db = getDb();
    const prefix = personalBrainPrefix(ref.bundleDir);
    const rows = await db
      .select({ path: agentFiles.path })
      .from(agentFiles)
      .where(and(eq(agentFiles.workspaceId, ref.workspaceId), eq(agentFiles.agentId, ref.agentId)));
    const deleted = rows.filter((row) =>
      row.path.slice(prefix.length).startsWith(`${folderPath}/`),
    );
    if (deleted.length === 0) return { ok: false, error: "Personal Brain folder not found." };

    const deletes = deleted.map((row) =>
      db
        .delete(agentFiles)
        .where(and(eq(agentFiles.workspaceId, ref.workspaceId), eq(agentFiles.path, row.path))),
    );
    const firstDelete = deletes[0];
    if (!firstDelete) return { ok: false, error: "Personal Brain folder not found." };
    await db.batch([firstDelete, ...deletes.slice(1)]);

    revalidatePath("/personal/brain");
    return { ok: true, path: folderPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Delete failed." };
  }
}

// --- Version history + restore (PRO-244) ---------------------------------------
//
// The runner captures the prior content of every personal-brain file before it
// overwrites/deletes it (brainFileVersions, scope="personal", agentId=the
// owning agent, path=the FULL agent_files repo path — NOT the logical UI path).
// These actions list those versions and roll a file back. Like every other
// personal-brain mutation they are LOCAL-ONLY: restores write to agent_files and
// never touch the workspace sync outbox. A restore is itself recorded as a new
// version row, so it is just as undoable as the change it reverts.

// What the UI needs to render the version list — never the full content (which
// can be up to 256 KB per row); content is only loaded on restore.
export type PersonalBrainFileVersionSummary = {
  id: number;
  operation: string;
  sizeBytes: number;
  createdAt: string;
  sessionId: string | null;
};

type ListResult =
  | { ok: true; versions: PersonalBrainFileVersionSummary[] }
  | { ok: false; error: string };

// List the saved versions for a single personal Brain file, newest first.
export async function listPersonalBrainFileVersions(path: string): Promise<ListResult> {
  try {
    const ref = await requirePersonalAgentRef();
    const repoPath = personalBrainRepoPath(ref.bundleDir, normalizeBrainPath(path));
    const rows = await getDb()
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
          eq(brainFileVersions.workspaceId, ref.workspaceId),
          eq(brainFileVersions.scope, "personal"),
          eq(brainFileVersions.path, repoPath),
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

// Restore a personal Brain file to a specific saved version. The current live
// content is first captured as a new version row (so the restore is undoable),
// then the file is upserted to the version's content via upsertPersonalBrainFile
// — local-only, no sync. A version whose `operation` was "delete" re-creates the
// file via the same upsert.
export async function restorePersonalBrainFileVersion(input: {
  path: string;
  versionId: number;
}): Promise<BrainActionResult> {
  try {
    const ref = await requirePersonalAgentRef();
    const logicalPath = normalizeBrainPath(input.path);
    const repoPath = personalBrainRepoPath(ref.bundleDir, logicalPath);
    const db = getDb();

    const [version] = await db
      .select()
      .from(brainFileVersions)
      .where(
        and(
          eq(brainFileVersions.id, input.versionId),
          eq(brainFileVersions.workspaceId, ref.workspaceId),
          eq(brainFileVersions.scope, "personal"),
          eq(brainFileVersions.path, repoPath),
        ),
      )
      .limit(1);
    if (!version) return { ok: false, error: "Version not found." };

    return await applyPersonalBrainRestore({ ref, logicalPath, repoPath, version });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Restore failed." };
  }
}

// "Step back a turn" for the personal Brain: restore the single most-recent saved
// version for the file (no multi-file/session grouping).
export async function restoreLatestPersonalBrainVersionBeforeTurn(
  path: string,
): Promise<BrainActionResult> {
  try {
    const ref = await requirePersonalAgentRef();
    const logicalPath = normalizeBrainPath(path);
    const repoPath = personalBrainRepoPath(ref.bundleDir, logicalPath);
    const db = getDb();

    const [version] = await db
      .select()
      .from(brainFileVersions)
      .where(
        and(
          eq(brainFileVersions.workspaceId, ref.workspaceId),
          eq(brainFileVersions.scope, "personal"),
          eq(brainFileVersions.path, repoPath),
        ),
      )
      .orderBy(desc(brainFileVersions.createdAt))
      .limit(1);
    if (!version) return { ok: false, error: "No previous version to restore." };

    return await applyPersonalBrainRestore({ ref, logicalPath, repoPath, version });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Restore failed." };
  }
}

// Shared restore body: snapshot the live content as a new version (unless it
// already matches the target), then write the version's content back through the
// normal local-only upsert path.
async function applyPersonalBrainRestore(input: {
  ref: Awaited<ReturnType<typeof requirePersonalAgentRef>>;
  logicalPath: string;
  repoPath: string;
  version: typeof brainFileVersions.$inferSelect;
}): Promise<BrainActionResult> {
  const { ref, logicalPath, repoPath, version } = input;
  const db = getDb();

  const [current] = await db
    .select({
      content: agentFiles.content,
      contentHash: agentFiles.contentHash,
      sizeBytes: agentFiles.sizeBytes,
    })
    .from(agentFiles)
    .where(and(eq(agentFiles.workspaceId, ref.workspaceId), eq(agentFiles.path, repoPath)))
    .limit(1);

  // Capture the live content as a new version before we overwrite it, so the
  // restore is itself undoable. Skip when the file already matches the target
  // (nothing would change, so there is nothing to preserve).
  if (current && current.contentHash !== version.contentHash) {
    await recordBrainFileVersion(db, {
      workspaceId: ref.workspaceId,
      scope: "personal",
      agentId: ref.agentId,
      path: repoPath,
      content: current.content,
      contentHash: current.contentHash,
      sizeBytes: current.sizeBytes,
      operation: "overwrite",
      sessionId: null,
    });
  }

  // Reuse the standard local-only edit path (upsert into agent_files, no sync).
  return await upsertPersonalBrainFile({
    path: logicalPath,
    content: version.content,
    createOnly: false,
  });
}
