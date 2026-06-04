import { type AgentBrainReference, shellQuote } from "@opencompany/agent-runtime";
import { agentSessionBrainMounts, brainFiles } from "@opencompany/db/schema";
import { enqueueWorkspaceSync } from "@opencompany/db/sync-outbox";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import { appendRuntimeEvent } from "./events";
import { conflictPath, hashContent } from "./repo-files";
import { type SandboxHandle, sandboxLayout } from "./sandbox";

export const MAX_BRAIN_FILE_BYTES = 256 * 1024;
export const MAX_BRAIN_MOUNT_FILES = 80;
export const MAX_BRAIN_MOUNT_BYTES = 2 * 1024 * 1024;
const BRAIN_REPO_PREFIX = "brain/";

type BrainFileRow = typeof brainFiles.$inferSelect;

export async function materializeBrainForSession(input: {
  sandbox: SandboxHandle;
  sessionId: string;
  workspaceId: string;
  workdir: string;
  references: AgentBrainReference[] | undefined;
}) {
  const references = input.references ?? [];
  const files = await expandBrainFiles(input.workspaceId, references);
  const folderReferences = references.filter((reference) => reference.type === "folder");
  const db = getDb();
  const layout = sandboxLayout(input.workdir);
  const brainManifestQuoted = shellQuote(layout.brainManifest);

  await input.sandbox.commands.run(
    `rm -rf ${shellQuote(layout.brainRoot)} && mkdir -p ${shellQuote(layout.brainRoot)}`,
  );
  // prepareWorkspace normally creates this first; keep this idempotent for resumed sessions/tests.
  await input.sandbox.commands.run(
    [
      `mkdir -p ${shellQuote(layout.metadataRoot)}`,
      `chown root:root ${shellQuote(layout.metadataRoot)}`,
      `chmod 700 ${shellQuote(layout.metadataRoot)}`,
    ].join(" && "),
    { user: "root", timeoutMs: 30_000 },
  );

  for (const file of files) {
    await input.sandbox.commands.run(
      `mkdir -p ${shellQuote(`${layout.brainRoot}/${dirname(file.path)}`)}`,
    );
    await input.sandbox.files.write(`${layout.brainRoot}/${file.path}`, file.content);
    await db
      .insert(agentSessionBrainMounts)
      .values({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        requestedPath: requestedPathFor(file.path, references),
        path: file.path,
        referenceType: "file",
        baseHash: file.contentHash,
        lastSyncedHash: file.contentHash,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [agentSessionBrainMounts.sessionId, agentSessionBrainMounts.path],
        set: {
          baseHash: file.contentHash,
          lastSyncedHash: file.contentHash,
          status: "mounted",
          updatedAt: new Date(),
        },
      });
  }

  for (const reference of folderReferences) {
    await db
      .insert(agentSessionBrainMounts)
      .values({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        requestedPath: reference.path,
        path: reference.path,
        referenceType: "folder",
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [agentSessionBrainMounts.sessionId, agentSessionBrainMounts.path],
        set: {
          status: "mounted",
          updatedAt: new Date(),
        },
      });
  }

  // The manifest is OpenCompany metadata. The agent sees Brain refs in its .agent file instead.
  await input.sandbox.files.write(
    layout.brainManifest,
    JSON.stringify(
      {
        root: "brain",
        references,
        files: files.map((file) => ({
          path: file.path,
          hash: file.contentHash,
          sizeBytes: file.sizeBytes,
        })),
        limits: {
          maxFiles: MAX_BRAIN_MOUNT_FILES,
          maxBytes: MAX_BRAIN_MOUNT_BYTES,
          maxFileBytes: MAX_BRAIN_FILE_BYTES,
        },
      },
      null,
      2,
    ),
    { user: "root" },
  );
  await input.sandbox.commands.run(
    `chown root:root ${brainManifestQuoted} && chmod 600 ${brainManifestQuoted}`,
    { user: "root" },
  );
  await input.sandbox.commands.run(`chown -R user:user ${shellQuote(layout.brainRoot)}`, {
    user: "root",
    timeoutMs: 30_000,
  });
}

export async function syncBrainFromSandbox(input: {
  sandbox: SandboxHandle;
  sessionId: string;
  workspaceId: string;
  workdir: string;
}) {
  const db = getDb();
  const mounts = await db
    .select()
    .from(agentSessionBrainMounts)
    .where(eq(agentSessionBrainMounts.sessionId, input.sessionId));
  if (mounts.length === 0) return;

  const result = await input.sandbox.commands.run(
    `cd ${shellQuote(input.workdir)} && if [ -d brain ]; then find brain -type f -print | sort; fi`,
    { timeoutMs: 30_000 },
  );
  const sandboxPaths = String(result.stdout ?? "")
    .split("\n")
    .filter(Boolean)
    .map((path) => normalizeBrainPath(stripBrainRepoPrefix(path)))
    .filter((path): path is string => Boolean(path));
  const sandboxPathSet = new Set(sandboxPaths);
  const fileMounts = mounts.filter((mount) => mount.referenceType === "file");
  const folderMounts = mounts.filter((mount) => mount.referenceType === "folder");

  for (const path of sandboxPaths) {
    if (!isAllowed(path, fileMounts, folderMounts)) continue;
    const content = await input.sandbox.files.read(`${input.workdir}/brain/${path}`);
    if (Buffer.byteLength(content, "utf8") > MAX_BRAIN_FILE_BYTES) continue;
    const hash = hashContent(content);
    const mount = fileMounts.find((item) => item.path === path);
    if (mount?.lastSyncedHash === hash) continue;

    const [current] = await db
      .select()
      .from(brainFiles)
      .where(and(eq(brainFiles.workspaceId, input.workspaceId), eq(brainFiles.path, path)))
      .limit(1);
    const targetPath =
      current &&
      mount?.baseHash &&
      current.contentHash !== mount.baseHash &&
      current.contentHash !== mount.lastSyncedHash
        ? conflictPath(path)
        : path;

    await upsertBrainFileFromRunner({
      workspaceId: input.workspaceId,
      path: targetPath,
      content,
      contentHash: hash,
    });
    await appendRuntimeEvent(db, {
      sessionId: input.sessionId,
      ...(targetPath === path
        ? {
            type: "brain.file_changed" as const,
            payload: { path, savedPath: targetPath, operation: "write" as const },
          }
        : {
            type: "brain.conflict" as const,
            payload: { path, savedPath: targetPath, operation: "conflict_copy" as const },
          }),
    });
    await db
      .insert(agentSessionBrainMounts)
      .values({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        requestedPath: mount?.requestedPath ?? path,
        path: targetPath,
        referenceType: "file",
        baseHash: hash,
        lastSyncedHash: hash,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [agentSessionBrainMounts.sessionId, agentSessionBrainMounts.path],
        set: {
          lastSyncedHash: hash,
          status: "synced",
          updatedAt: new Date(),
        },
      });
  }

  for (const mount of fileMounts) {
    if (sandboxPathSet.has(mount.path)) continue;
    const [current] = await db
      .select()
      .from(brainFiles)
      .where(and(eq(brainFiles.workspaceId, input.workspaceId), eq(brainFiles.path, mount.path)))
      .limit(1);
    if (current && current.contentHash !== mount.baseHash) {
      await appendRuntimeEvent(db, {
        sessionId: input.sessionId,
        type: "brain.conflict",
        payload: { path: mount.path, operation: "delete_conflict" },
      });
      continue;
    }
    await db.transaction(async (tx) => {
      await tx
        .delete(brainFiles)
        .where(and(eq(brainFiles.workspaceId, input.workspaceId), eq(brainFiles.path, mount.path)));
      await enqueueWorkspaceSync(tx, {
        workspaceId: input.workspaceId,
        repoPath: brainRepoPath(mount.path),
        sourceKind: "brain",
        operation: "delete",
        desiredHash: null,
        previousBlobSha: current?.githubBlobSha ?? null,
      });
    });
    await appendRuntimeEvent(db, {
      sessionId: input.sessionId,
      type: "brain.file_changed",
      payload: { path: mount.path, operation: "delete" },
    });
  }
}

async function expandBrainFiles(workspaceId: string, references: AgentBrainReference[]) {
  if (references.length === 0) return [];
  const rows = await getDb()
    .select()
    .from(brainFiles)
    .where(eq(brainFiles.workspaceId, workspaceId));
  const files: BrainFileRow[] = [];
  let bytes = 0;

  for (const row of rows.sort((a, b) => a.path.localeCompare(b.path))) {
    if (!references.some((reference) => matchesReference(row.path, reference))) continue;
    if (row.sizeBytes > MAX_BRAIN_FILE_BYTES) continue;
    if (files.length >= MAX_BRAIN_MOUNT_FILES) break;
    if (bytes + row.sizeBytes > MAX_BRAIN_MOUNT_BYTES) break;
    files.push(row);
    bytes += row.sizeBytes;
  }

  return files;
}

function matchesReference(path: string, reference: AgentBrainReference) {
  if (reference.type === "folder" && reference.path === "/") return true;
  return reference.type === "folder" ? path.startsWith(reference.path) : path === reference.path;
}

function requestedPathFor(path: string, references: AgentBrainReference[]) {
  return references.find((reference) => matchesReference(path, reference))?.path ?? path;
}

function isAllowed(
  path: string,
  fileMounts: Array<{ path: string }>,
  folderMounts: Array<{ path: string }>,
) {
  return (
    fileMounts.some((mount) => mount.path === path) ||
    folderMounts.some((mount) => mount.path === "/" || path.startsWith(mount.path))
  );
}

// Canonical-only writeback: persist Brain content to Postgres and enqueue a
// workspace sync job. GitHub projection happens asynchronously through the
// unified projector, so the session never blocks on a GitHub round-trip.
async function upsertBrainFileFromRunner(input: {
  workspaceId: string;
  path: string;
  content: string;
  contentHash: string;
}) {
  const db = getDb();
  const sizeBytes = Buffer.byteLength(input.content, "utf8");
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .insert(brainFiles)
      .values({
        workspaceId: input.workspaceId,
        path: input.path,
        content: input.content,
        contentHash: input.contentHash,
        sizeBytes,
        githubSyncStatus: "pending",
        githubSyncError: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [brainFiles.workspaceId, brainFiles.path],
        set: {
          content: input.content,
          contentHash: input.contentHash,
          sizeBytes,
          githubSyncStatus: "pending",
          githubSyncError: null,
          updatedAt: now,
        },
      });

    await enqueueWorkspaceSync(tx, {
      workspaceId: input.workspaceId,
      repoPath: brainRepoPath(input.path),
      sourceKind: "brain",
      operation: "upsert",
      desiredHash: input.contentHash,
    });
  });
}

function normalizeBrainPath(input: string) {
  const path = input.trim().replace(/^\/+/, "").split("/").filter(Boolean).join("/");
  if (!path || path.startsWith(".") || path.includes("..")) return null;
  return path;
}

function dirname(path: string) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

function brainRepoPath(path: string) {
  return `${BRAIN_REPO_PREFIX}${path}`;
}

function stripBrainRepoPrefix(path: string) {
  return path.startsWith(BRAIN_REPO_PREFIX) ? path.slice(BRAIN_REPO_PREFIX.length) : path;
}
