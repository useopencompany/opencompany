import { createHash } from "node:crypto";
import {
  type AgentBrainReference,
  BRAIN_SYNC_DELAY_MS,
  shellQuote,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import {
  agentSessionBrainMounts,
  brainFiles,
  brainSyncJobs,
  type WorkspaceRepository,
} from "@opencompany/db/schema";
import { createLogger } from "@opencompany/observability";
import { and, eq } from "drizzle-orm";
import { appendRuntimeEvent } from "./events";
import { getGitHubInstallationToken } from "./github";
import { type SandboxHandle, sandboxLayout } from "./sandbox";

const MAX_BRAIN_FILE_BYTES = 256 * 1024;
const MAX_BRAIN_MOUNT_FILES = 80;
const MAX_BRAIN_MOUNT_BYTES = 2 * 1024 * 1024;
const logger = createLogger({ service: "opencompany-runner", runtime: "server" });

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

  // The manifest is OpenCompany metadata. The agent sees Brain refs in agent.agent instead.
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
  repository?: WorkspaceRepository | null | undefined;
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
    .map((path) => normalizeBrainPath(path.replace(/^brain\//, "")))
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
      repository: input.repository,
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
    await db
      .delete(brainFiles)
      .where(and(eq(brainFiles.workspaceId, input.workspaceId), eq(brainFiles.path, mount.path)));
    await deleteBrainFileFromGitHub(input.repository, mount.path, current?.githubBlobSha ?? null);
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

async function upsertBrainFileFromRunner(input: {
  workspaceId: string;
  path: string;
  content: string;
  contentHash: string;
  repository?: WorkspaceRepository | null | undefined;
}) {
  const db = getDb();
  const sizeBytes = Buffer.byteLength(input.content, "utf8");
  let github = { commitSha: null as string | null, blobSha: null as string | null };
  let shouldQueueSync = false;

  try {
    github = await writeBrainFileToGitHub(input.repository, input.path, input.content);
    shouldQueueSync = !github.commitSha;
  } catch (error) {
    logger.warn("Queued Brain GitHub sync after immediate write failed", {
      error,
      workspace_id: input.workspaceId,
      brain_path: input.path,
    });
    shouldQueueSync = true;
  }

  const now = new Date();
  if (github.commitSha) {
    await db
      .insert(brainFiles)
      .values({
        workspaceId: input.workspaceId,
        path: input.path,
        content: input.content,
        contentHash: input.contentHash,
        sizeBytes,
        githubBlobSha: github.blobSha,
        githubCommitSha: github.commitSha,
        githubSyncedHash: input.contentHash,
        githubSyncedAt: now,
        githubSyncStatus: "synced",
        githubSyncError: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [brainFiles.workspaceId, brainFiles.path],
        set: {
          content: input.content,
          contentHash: input.contentHash,
          sizeBytes,
          githubBlobSha: github.blobSha,
          githubCommitSha: github.commitSha,
          githubSyncedHash: input.contentHash,
          githubSyncedAt: now,
          githubSyncStatus: "synced",
          githubSyncError: null,
          updatedAt: now,
        },
      });
    return;
  }

  await db
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

  if (shouldQueueSync) {
    await upsertBrainSyncJob({
      workspaceId: input.workspaceId,
      path: input.path,
      operation: "upsert",
      desiredHash: input.contentHash,
    });
  }
}

async function writeBrainFileToGitHub(
  repository: WorkspaceRepository | null | undefined,
  path: string,
  content: string,
) {
  if (!repository) return { commitSha: null, blobSha: null };
  const token = await getGitHubInstallationToken();
  if (!token) return { commitSha: null, blobSha: null };
  const repositoryPath = githubRepositoryPath(repository.fullName);
  const current = await getGitHubFile(token, repository, `brain/${path}`);
  const result = await githubRequest<{ content?: { sha?: string }; commit?: { sha?: string } }>({
    token,
    repository,
    path: `/repos/${repositoryPath}/contents/${encodeURIComponentPath(`brain/${path}`)}`,
    method: "PUT",
    body: {
      message: `Update brain/${path}`,
      branch: repository.defaultBranch,
      content: Buffer.from(content, "utf8").toString("base64"),
      ...(current?.sha ? { sha: current.sha } : {}),
    },
  });
  return { commitSha: result.commit?.sha ?? null, blobSha: result.content?.sha ?? null };
}

async function deleteBrainFileFromGitHub(
  repository: WorkspaceRepository | null | undefined,
  path: string,
  blobSha: string | null,
) {
  if (!repository) return;
  const token = await getGitHubInstallationToken();
  if (!token) return;
  const repositoryPath = githubRepositoryPath(repository.fullName);
  const current = blobSha
    ? { sha: blobSha }
    : await getGitHubFile(token, repository, `brain/${path}`);
  if (!current?.sha) return;
  await githubRequest({
    token,
    repository,
    path: `/repos/${repositoryPath}/contents/${encodeURIComponentPath(`brain/${path}`)}`,
    method: "DELETE",
    body: {
      message: `Delete brain/${path}`,
      branch: repository.defaultBranch,
      sha: current.sha,
    },
  });
}

async function upsertBrainSyncJob(input: {
  workspaceId: string;
  path: string;
  operation: "upsert" | "delete";
  desiredHash: string | null;
  previousPath?: string | null;
  previousBlobSha?: string | null;
}) {
  const now = new Date();
  const nextRunAt = new Date(now.getTime() + BRAIN_SYNC_DELAY_MS);
  await getDb()
    .insert(brainSyncJobs)
    .values({
      workspaceId: input.workspaceId,
      path: input.path,
      operation: input.operation,
      desiredHash: input.desiredHash,
      previousPath: input.previousPath ?? null,
      previousBlobSha: input.previousBlobSha ?? null,
      nextRunAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [brainSyncJobs.workspaceId, brainSyncJobs.path],
      set: {
        operation: input.operation,
        desiredHash: input.desiredHash,
        previousPath: input.previousPath ?? null,
        previousBlobSha: input.previousBlobSha ?? null,
        status: "pending",
        nextRunAt,
        lastError: null,
        updatedAt: now,
      },
    });
}

async function getGitHubFile(token: string, repository: WorkspaceRepository, path: string) {
  try {
    const repositoryPath = githubRepositoryPath(repository.fullName);
    return await githubRequest<{ sha?: string }>({
      token,
      repository,
      path: `/repos/${repositoryPath}/contents/${encodeURIComponentPath(path)}?ref=${encodeURIComponent(repository.defaultBranch)}`,
      method: "GET",
    });
  } catch (error) {
    if (error instanceof Error && /404|not found/i.test(error.message)) return null;
    throw error;
  }
}

async function githubRequest<T = unknown>(input: {
  token: string;
  repository: WorkspaceRepository;
  path: string;
  method: "GET" | "PUT" | "DELETE";
  body?: unknown;
}): Promise<T> {
  const init: RequestInit = {
    method: input.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };
  if (input.body !== undefined) {
    init.body = JSON.stringify(input.body);
  }
  const response = await fetch(`https://api.github.com${input.path}`, init);
  if (!response.ok) {
    throw new Error(`GitHub request failed with ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
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

function hashContent(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function conflictPath(path: string) {
  const dot = path.lastIndexOf(".");
  const suffix = `.conflict-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (dot <= 0) return `${path}${suffix}`;
  return `${path.slice(0, dot)}${suffix}${path.slice(dot)}`;
}

function encodeURIComponentPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function githubRepositoryPath(fullName: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    throw new Error("Invalid GitHub repository full name.");
  }
  return fullName;
}
