"use server";

import { getDb } from "@opencompany/db/client";
import { brainFiles, brainSyncJobs } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentWorkspace } from "@/lib/auth";
import { brainContentSize, hashBrainContent } from "@/lib/brain/hash";
import { brainSyncJobUpsert, resolveBrainSyncRename } from "@/lib/brain/jobs";
import {
  folderPlaceholderPath,
  isBrainTextFile,
  MAX_BRAIN_FILE_BYTES,
  normalizeBrainPath,
} from "@/lib/brain/paths";
import { scheduleBrainSyncDispatch } from "@/lib/brain/sync-dispatch";
import { hasOtherFilesInFolder, parentFolderPath } from "@/lib/brain/tree";

type BrainActionResult = { ok: true; path: string } | { ok: false; error: string };

export async function createBrainFile(path: string, content = ""): Promise<BrainActionResult> {
  return upsertBrainFile({ path, content, createOnly: true });
}

/**
 * Persists an otherwise-empty folder by writing a hidden placeholder file
 * (e.g. `<folder>/.gitkeep`). Folders are virtual, so without a file inside
 * them they cannot exist. The placeholder is filtered out of the Brain tree UI.
 */
export async function createBrainFolder(folderPath: string): Promise<BrainActionResult> {
  return upsertBrainFile({
    path: folderPlaceholderPath(folderPath),
    content: "",
    createOnly: true,
  });
}

export async function updateBrainFile(path: string, content: string): Promise<BrainActionResult> {
  return upsertBrainFile({ path, content, createOnly: false });
}

export async function renameBrainFile(
  fromPath: string,
  toPath: string,
): Promise<BrainActionResult> {
  const { workspace } = await currentWorkspace();
  const db = getDb();

  try {
    const from = normalizeBrainPath(fromPath);
    const to = normalizeBrainPath(toPath);
    if (from === to) return { ok: true, path: to };

    const [existing] = await db
      .select()
      .from(brainFiles)
      .where(and(eq(brainFiles.workspaceId, workspace.id), eq(brainFiles.path, from)))
      .limit(1);
    if (!existing) return { ok: false, error: "Brain file not found." };

    const [destination] = await db
      .select({ path: brainFiles.path })
      .from(brainFiles)
      .where(and(eq(brainFiles.workspaceId, workspace.id), eq(brainFiles.path, to)))
      .limit(1);
    if (destination) return { ok: false, error: "A Brain file already exists at that path." };

    const [existingRenameJob] = await db
      .select({
        previousPath: brainSyncJobs.previousPath,
        previousBlobSha: brainSyncJobs.previousBlobSha,
      })
      .from(brainSyncJobs)
      .where(and(eq(brainSyncJobs.workspaceId, workspace.id), eq(brainSyncJobs.path, from)))
      .limit(1);
    const rename = resolveBrainSyncRename({
      existingPreviousPath: existingRenameJob?.previousPath,
      existingPreviousBlobSha: existingRenameJob?.previousBlobSha,
      renamePreviousPath: from,
      renamePreviousBlobSha: existing.githubBlobSha,
    });

    const now = new Date();
    const [inserted] = await db
      .insert(brainFiles)
      .values({
        workspaceId: workspace.id,
        path: to,
        content: existing.content,
        contentHash: existing.contentHash,
        sizeBytes: existing.sizeBytes,
        githubSyncStatus: "pending",
        githubSyncError: null,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ path: brainFiles.path });
    if (!inserted) return { ok: false, error: "A Brain file already exists at that path." };

    await db.batch([
      db
        .delete(brainFiles)
        .where(and(eq(brainFiles.workspaceId, workspace.id), eq(brainFiles.path, from))),
      brainSyncJobUpsert(db, {
        workspaceId: workspace.id,
        path: to,
        operation: "upsert",
        desiredHash: existing.contentHash,
        previousPath: rename.previousPath,
        previousBlobSha: rename.previousBlobSha,
      }),
    ]);

    scheduleBrainSyncDispatch({ workspaceId: workspace.id, path: to });
    revalidatePath("/brain");
    return { ok: true, path: to };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Rename failed." };
  }
}

export async function renameBrainFolder(
  fromPath: string,
  toPath: string,
): Promise<BrainActionResult> {
  const { workspace } = await currentWorkspace();
  const db = getDb();

  try {
    const from = normalizeBrainFolderPath(fromPath);
    const to = normalizeBrainFolderPath(toPath);
    if (from === to) return { ok: true, path: to };
    if (to.startsWith(`${from}/`)) {
      return { ok: false, error: "Folders cannot be moved inside themselves." };
    }

    const files = await db
      .select()
      .from(brainFiles)
      .where(eq(brainFiles.workspaceId, workspace.id));
    const movingFiles = files.filter((file) => file.path.startsWith(`${from}/`));
    if (movingFiles.length === 0) return { ok: false, error: "Brain folder not found." };

    const movingPaths = new Set(movingFiles.map((file) => file.path));
    const existingPaths = new Set(files.map((file) => file.path));
    const movedFiles = movingFiles.map((file) => {
      const relativePath = file.path.slice(from.length + 1);
      return {
        file,
        path: `${to}/${relativePath}`,
      };
    });

    if (existingPaths.has(to) && !movingPaths.has(to)) {
      return { ok: false, error: "A Brain file already exists at that path." };
    }

    const collision = movedFiles.find(
      (move) => existingPaths.has(move.path) && !movingPaths.has(move.path),
    );
    if (collision) return { ok: false, error: `A Brain file already exists at ${collision.path}.` };

    const existingRenameJobs = await db
      .select({
        path: brainSyncJobs.path,
        previousPath: brainSyncJobs.previousPath,
        previousBlobSha: brainSyncJobs.previousBlobSha,
      })
      .from(brainSyncJobs)
      .where(eq(brainSyncJobs.workspaceId, workspace.id));
    const jobByPath = new Map(existingRenameJobs.map((job) => [job.path, job]));
    const now = new Date();

    await db.batch([
      db.insert(brainFiles).values(
        movedFiles.map(({ file, path }) => ({
          workspaceId: workspace.id,
          path,
          content: file.content,
          contentHash: file.contentHash,
          sizeBytes: file.sizeBytes,
          githubSyncStatus: "pending",
          githubSyncError: null,
          updatedAt: now,
        })),
      ),
      ...movingFiles.map((file) =>
        db
          .delete(brainFiles)
          .where(and(eq(brainFiles.workspaceId, workspace.id), eq(brainFiles.path, file.path))),
      ),
      ...movedFiles.map(({ file, path }) => {
        const existingRenameJob = jobByPath.get(file.path);
        const rename = resolveBrainSyncRename({
          existingPreviousPath: existingRenameJob?.previousPath,
          existingPreviousBlobSha: existingRenameJob?.previousBlobSha,
          renamePreviousPath: file.path,
          renamePreviousBlobSha: file.githubBlobSha,
        });
        return brainSyncJobUpsert(db, {
          workspaceId: workspace.id,
          path,
          operation: "upsert",
          desiredHash: file.contentHash,
          previousPath: rename.previousPath,
          previousBlobSha: rename.previousBlobSha,
        });
      }),
    ]);

    for (const move of movedFiles) {
      scheduleBrainSyncDispatch({ workspaceId: workspace.id, path: move.path });
    }
    revalidatePath("/brain");
    return { ok: true, path: to };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Move failed." };
  }
}

export async function deleteBrainFile(path: string): Promise<BrainActionResult> {
  const { workspace } = await currentWorkspace();
  const db = getDb();

  try {
    const normalized = normalizeBrainPath(path);
    const files = await db
      .select({ path: brainFiles.path, githubBlobSha: brainFiles.githubBlobSha })
      .from(brainFiles)
      .where(eq(brainFiles.workspaceId, workspace.id));
    const existing = files.find((file) => file.path === normalized);

    // Keep a freshly-emptied folder alive by writing a hidden placeholder, so a
    // user who deletes the auto-created file can still add a subfolder (PRO-65).
    const folderPath = parentFolderPath(normalized);
    const keepFolder = Boolean(folderPath) && !hasOtherFilesInFolder(files, folderPath, normalized);
    const placeholderPath = keepFolder ? folderPlaceholderPath(folderPath) : "";
    const placeholderExists = keepFolder && files.some((file) => file.path === placeholderPath);

    const now = new Date();
    const placeholderQueries =
      keepFolder && !placeholderExists
        ? [
            db.insert(brainFiles).values({
              workspaceId: workspace.id,
              path: placeholderPath,
              content: "",
              contentHash: hashBrainContent(""),
              sizeBytes: brainContentSize(""),
              githubSyncStatus: "pending",
              githubSyncError: null,
              updatedAt: now,
            }),
            brainSyncJobUpsert(db, {
              workspaceId: workspace.id,
              path: placeholderPath,
              operation: "upsert",
              desiredHash: hashBrainContent(""),
            }),
          ]
        : [];

    await db.batch([
      db
        .delete(brainFiles)
        .where(and(eq(brainFiles.workspaceId, workspace.id), eq(brainFiles.path, normalized))),
      brainSyncJobUpsert(db, {
        workspaceId: workspace.id,
        path: normalized,
        operation: "delete",
        desiredHash: null,
        previousBlobSha: existing?.githubBlobSha ?? null,
      }),
      ...placeholderQueries,
    ]);

    scheduleBrainSyncDispatch({ workspaceId: workspace.id, path: normalized });
    if (placeholderQueries.length > 0) {
      scheduleBrainSyncDispatch({ workspaceId: workspace.id, path: placeholderPath });
    }
    revalidatePath("/brain");
    return { ok: true, path: normalized };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Delete failed." };
  }
}

export async function deleteBrainFolder(path: string): Promise<BrainActionResult> {
  const { workspace } = await currentWorkspace();
  const db = getDb();

  try {
    const folderPath = normalizeBrainFolderPath(path);
    const files = await db
      .select({
        path: brainFiles.path,
        githubBlobSha: brainFiles.githubBlobSha,
      })
      .from(brainFiles)
      .where(eq(brainFiles.workspaceId, workspace.id));
    const deletedFiles = files.filter((file) => file.path.startsWith(`${folderPath}/`));
    if (deletedFiles.length === 0) return { ok: false, error: "Brain folder not found." };

    const deleteQueries = deletedFiles.flatMap((file) => [
      db
        .delete(brainFiles)
        .where(and(eq(brainFiles.workspaceId, workspace.id), eq(brainFiles.path, file.path))),
      brainSyncJobUpsert(db, {
        workspaceId: workspace.id,
        path: file.path,
        operation: "delete",
        desiredHash: null,
        previousBlobSha: file.githubBlobSha,
      }),
    ]);
    const firstDeleteQuery = deleteQueries[0];
    if (!firstDeleteQuery) return { ok: false, error: "Brain folder not found." };

    await db.batch([firstDeleteQuery, ...deleteQueries.slice(1)]);

    for (const file of deletedFiles) {
      scheduleBrainSyncDispatch({ workspaceId: workspace.id, path: file.path });
    }
    revalidatePath("/brain");
    return { ok: true, path: folderPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Delete failed." };
  }
}

async function upsertBrainFile(input: {
  path: string;
  content: string;
  createOnly: boolean;
}): Promise<BrainActionResult> {
  const { workspace } = await currentWorkspace();

  try {
    const path = normalizeBrainPath(input.path);
    if (!isBrainTextFile(path))
      return { ok: false, error: "Only text files are supported in Brain." };
    const sizeBytes = brainContentSize(input.content);
    if (sizeBytes > MAX_BRAIN_FILE_BYTES) {
      return { ok: false, error: "Brain files must be 256 KB or smaller." };
    }

    const db = getDb();
    const contentHash = hashBrainContent(input.content);
    const now = new Date();
    const insert = db.insert(brainFiles).values({
      workspaceId: workspace.id,
      path,
      content: input.content,
      contentHash,
      sizeBytes,
      githubSyncStatus: "pending",
      githubSyncError: null,
      updatedAt: now,
    });

    await db.batch([
      input.createOnly
        ? insert.onConflictDoNothing()
        : insert.onConflictDoUpdate({
            target: [brainFiles.workspaceId, brainFiles.path],
            set: {
              content: input.content,
              contentHash,
              sizeBytes,
              githubSyncStatus: "pending",
              githubSyncError: null,
              updatedAt: now,
            },
          }),
      brainSyncJobUpsert(db, {
        workspaceId: workspace.id,
        path,
        operation: "upsert",
        desiredHash: contentHash,
      }),
    ]);

    scheduleBrainSyncDispatch({ workspaceId: workspace.id, path });
    revalidatePath("/brain");
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Save failed." };
  }
}

function normalizeBrainFolderPath(path: string) {
  return normalizeBrainPath(`${path.replace(/\/+$/g, "")}/`, { allowFolder: true }).replace(
    /\/$/g,
    "",
  );
}
