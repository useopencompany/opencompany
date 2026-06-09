"use server";

import { getDb } from "@opencompany/db/client";
import { agentFiles } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
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
    const logicalByPath = new Map(brainRows.map((row) => [row.path, row.path.slice(prefix.length)]));

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
    const deleted = rows.filter((row) => row.path.slice(prefix.length).startsWith(`${folderPath}/`));
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
