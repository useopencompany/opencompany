import { agentBundleDir, shellQuote } from "@opencompany/agent-runtime";
import { agentFiles, agentSessionBundleMounts, agents } from "@opencompany/db/schema";
import { enqueueWorkspaceSync } from "@opencompany/db/sync-outbox";
import { createLogger } from "@opencompany/observability";
import { and, eq } from "drizzle-orm";
import { MAX_BRAIN_FILE_BYTES, MAX_BRAIN_MOUNT_BYTES, MAX_BRAIN_MOUNT_FILES } from "./brain";
import { getDb } from "./db";
import { appendRuntimeEvent } from "./events";
import { conflictPath, hashContent } from "./repo-files";
import { type SandboxHandle, sandboxLayout } from "./sandbox";

const MAX_AGENT_BUNDLE_FILE_BYTES = MAX_BRAIN_FILE_BYTES;
const MAX_AGENT_BUNDLE_MOUNT_FILES = MAX_BRAIN_MOUNT_FILES;
const MAX_AGENT_BUNDLE_MOUNT_BYTES = MAX_BRAIN_MOUNT_BYTES;
// Profile file: always-present so the agent can read/edit it and so the runtime can inject it
// into the system prompt every session (see resolveAgentRuntimeConfig). Created empty when
// absent, exactly like a freshly-seeded scratchpad.
const AGENT_USER_MEMORY_PATH = "user.md";
const logger = createLogger({ service: "opencompany-runner", runtime: "server" });

type AgentFileRow = typeof agentFiles.$inferSelect;

export async function materializeAgentBundleForSession(input: {
  sandbox: SandboxHandle;
  sessionId: string;
  workspaceId: string;
  agentId: string;
  workdir: string;
}) {
  const db = getDb();
  const bundle = await loadAgentBundle(input.workspaceId, input.agentId);
  const rows = await db
    .select()
    .from(agentFiles)
    .where(
      and(eq(agentFiles.workspaceId, input.workspaceId), eq(agentFiles.agentId, input.agentId)),
    );
  const files = rows
    .map((row) => toMountedAgentFile(row, bundle.dir))
    .filter((file): file is MountedAgentFile => Boolean(file))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const limitedFiles = limitMountedAgentFiles(files);
  const layout = sandboxLayout(input.workdir);

  // Defensive guard: agentRoot drives a destructive `rm -rf`. workdir comes
  // from a system-controlled session record, but refuse to run if it ever
  // resolves to a malformed path (empty workdir, missing /agent suffix).
  if (!layout.agentRoot || !/.+\/agent$/.test(layout.agentRoot)) {
    throw new Error(`Refusing destructive rm -rf on malformed agent root: ${layout.agentRoot}`);
  }

  await input.sandbox.commands.run(
    `rm -rf ${shellQuote(layout.agentRoot)} && mkdir -p ${shellQuote(layout.agentRoot)}`,
  );

  const mountedPaths = new Set<string>();
  for (const file of limitedFiles) {
    await input.sandbox.commands.run(
      `mkdir -p ${shellQuote(`${layout.agentRoot}/${dirname(file.relativePath)}`)}`,
    );
    await input.sandbox.files.write(`${layout.agentRoot}/${file.relativePath}`, file.content);
    mountedPaths.add(file.relativePath);
    await mountAgentBundleFile({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      repoPath: file.repoPath,
      relativePath: file.relativePath,
      contentHash: file.contentHash,
    });
  }

  for (const path of [AGENT_USER_MEMORY_PATH]) {
    if (mountedPaths.has(path)) continue;
    const contentHash = hashContent("");
    await input.sandbox.files.write(`${layout.agentRoot}/${path}`, "");
    await mountAgentBundleFile({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      repoPath: repoPathFor(bundle.dir, path),
      relativePath: path,
      contentHash,
    });
  }

  await input.sandbox.commands.run(`chown -R user:user ${shellQuote(layout.agentRoot)}`, {
    user: "root",
    timeoutMs: 30_000,
  });
}

export async function syncAgentBundleFromSandbox(input: {
  sandbox: SandboxHandle;
  sessionId: string;
  workspaceId: string;
  agentId: string;
  workdir: string;
}) {
  const db = getDb();
  const bundle = await loadAgentBundle(input.workspaceId, input.agentId);
  const mounts = await db
    .select()
    .from(agentSessionBundleMounts)
    .where(eq(agentSessionBundleMounts.sessionId, input.sessionId));
  if (mounts.length === 0) return;

  const result = await input.sandbox.commands.run(
    `cd ${shellQuote(input.workdir)} && if [ -d agent ]; then find agent -type f -print | sort; fi`,
    { timeoutMs: 30_000 },
  );
  const sandboxPaths = String(result.stdout ?? "")
    .split("\n")
    .filter(Boolean)
    .map((path) => normalizeAgentBundlePath(stripAgentSandboxPrefix(path)))
    .filter((path): path is string => Boolean(path));
  const sandboxPathSet = new Set(sandboxPaths);
  const fileMounts = mounts.filter((mount) => mount.referenceType === "file");
  let syncedFiles = 0;
  let syncedBytes = 0;

  for (const relativePath of sandboxPaths) {
    const repoPath = repoPathFor(bundle.dir, relativePath);
    assertInsideBundle(repoPath, bundle.dir);
    // A file can be deleted/become unreadable between the listing above and
    // this read. Skip it rather than aborting the whole sync.
    let content: string;
    try {
      content = await input.sandbox.files.read(`${input.workdir}/agent/${relativePath}`);
    } catch (error) {
      logger.warn("Skipping unreadable file during agent bundle sync", {
        session_id: input.sessionId,
        workspace_id: input.workspaceId,
        path: relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const sizeBytes = Buffer.byteLength(content, "utf8");
    if (sizeBytes > MAX_AGENT_BUNDLE_FILE_BYTES) continue;
    if (syncedFiles >= MAX_AGENT_BUNDLE_MOUNT_FILES) break;
    if (syncedBytes + sizeBytes > MAX_AGENT_BUNDLE_MOUNT_BYTES) break;
    syncedFiles += 1;
    syncedBytes += sizeBytes;
    const hash = hashContent(content);
    const mount = fileMounts.find((item) => item.path === repoPath);
    if (mount?.lastSyncedHash === hash) continue;

    const [current] = await db
      .select()
      .from(agentFiles)
      .where(and(eq(agentFiles.workspaceId, input.workspaceId), eq(agentFiles.path, repoPath)))
      .limit(1);
    const targetPath =
      current &&
      mount?.baseHash &&
      current.contentHash !== mount.baseHash &&
      current.contentHash !== mount.lastSyncedHash
        ? conflictPath(repoPath)
        : repoPath;
    assertInsideBundle(targetPath, bundle.dir);

    await upsertAgentFileFromRunner({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      path: targetPath,
      content,
      contentHash: hash,
    });
    await appendRuntimeEvent(db, {
      sessionId: input.sessionId,
      ...(targetPath === repoPath
        ? {
            type: "agent_bundle.file_changed" as const,
            payload: { path: repoPath, savedPath: targetPath, operation: "write" as const },
          }
        : {
            type: "agent_bundle.conflict" as const,
            payload: {
              path: repoPath,
              savedPath: targetPath,
              operation: "conflict_copy" as const,
            },
          }),
    });
    await db
      .insert(agentSessionBundleMounts)
      .values({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        requestedPath: `agent/${relativePath}`,
        path: targetPath,
        referenceType: "file",
        baseHash: hash,
        lastSyncedHash: hash,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [agentSessionBundleMounts.sessionId, agentSessionBundleMounts.path],
        set: {
          lastSyncedHash: hash,
          status: "synced",
          updatedAt: new Date(),
        },
      });
  }

  for (const mount of fileMounts) {
    if (!mount.path.startsWith(`${bundle.dir}/`)) continue;
    const relativePath = stripBundlePrefix(mount.path, bundle.dir);
    if (!relativePath || sandboxPathSet.has(relativePath)) continue;
    const [current] = await db
      .select()
      .from(agentFiles)
      .where(and(eq(agentFiles.workspaceId, input.workspaceId), eq(agentFiles.path, mount.path)))
      .limit(1);
    if (current && current.contentHash !== mount.baseHash) {
      await appendRuntimeEvent(db, {
        sessionId: input.sessionId,
        type: "agent_bundle.conflict",
        payload: { path: mount.path, operation: "delete_conflict" },
      });
      continue;
    }
    await db.transaction(async (tx) => {
      await tx
        .delete(agentFiles)
        .where(and(eq(agentFiles.workspaceId, input.workspaceId), eq(agentFiles.path, mount.path)));
      await enqueueWorkspaceSync(tx, {
        workspaceId: input.workspaceId,
        repoPath: mount.path,
        sourceKind: "agent_file",
        operation: "delete",
        desiredHash: null,
        previousBlobSha: current?.githubBlobSha ?? null,
      });
    });
    await appendRuntimeEvent(db, {
      sessionId: input.sessionId,
      type: "agent_bundle.file_changed",
      payload: { path: mount.path, operation: "delete" },
    });
  }
}

async function loadAgentBundle(workspaceId: string, agentId: string) {
  const [agent] = await getDb()
    .select({ path: agents.path })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
    .limit(1);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  if (!agent.path) {
    throw new Error(`Agent bundle path is missing: ${agentId}`);
  }

  return { dir: agentBundleDir(agent.path) };
}

async function mountAgentBundleFile(input: {
  sessionId: string;
  workspaceId: string;
  repoPath: string;
  relativePath: string;
  contentHash: string;
}) {
  await getDb()
    .insert(agentSessionBundleMounts)
    .values({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      requestedPath: `agent/${input.relativePath}`,
      path: input.repoPath,
      referenceType: "file",
      baseHash: input.contentHash,
      lastSyncedHash: input.contentHash,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [agentSessionBundleMounts.sessionId, agentSessionBundleMounts.path],
      set: {
        baseHash: input.contentHash,
        lastSyncedHash: input.contentHash,
        status: "mounted",
        updatedAt: new Date(),
      },
    });
}

// Canonical-only writeback: persist the bundle file to Postgres and enqueue a
// workspace sync job. GitHub projection is async via the unified projector.
async function upsertAgentFileFromRunner(input: {
  workspaceId: string;
  agentId: string;
  path: string;
  content: string;
  contentHash: string;
}) {
  const db = getDb();
  const sizeBytes = Buffer.byteLength(input.content, "utf8");
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .insert(agentFiles)
      .values({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        path: input.path,
        content: input.content,
        contentHash: input.contentHash,
        sizeBytes,
        githubSyncStatus: "pending",
        githubSyncError: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [agentFiles.workspaceId, agentFiles.path],
        set: {
          agentId: input.agentId,
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
      repoPath: input.path,
      sourceKind: "agent_file",
      operation: "upsert",
      desiredHash: input.contentHash,
    });
  });
}

type MountedAgentFile = {
  repoPath: string;
  relativePath: string;
  content: string;
  contentHash: string;
  sizeBytes: number;
};

function toMountedAgentFile(row: AgentFileRow, bundleDir: string): MountedAgentFile | null {
  const relativePath = stripBundlePrefix(row.path, bundleDir);
  const normalized = relativePath ? normalizeAgentBundlePath(relativePath) : null;
  if (!normalized || normalized !== relativePath) return null;
  return {
    repoPath: row.path,
    relativePath: normalized,
    content: row.content,
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes,
  };
}

function limitMountedAgentFiles(files: MountedAgentFile[]) {
  const mounted: MountedAgentFile[] = [];
  let bytes = 0;

  for (const file of files) {
    if (file.sizeBytes > MAX_AGENT_BUNDLE_FILE_BYTES) continue;
    if (mounted.length >= MAX_AGENT_BUNDLE_MOUNT_FILES) break;
    if (bytes + file.sizeBytes > MAX_AGENT_BUNDLE_MOUNT_BYTES) break;
    mounted.push(file);
    bytes += file.sizeBytes;
  }

  return mounted;
}

function repoPathFor(bundleDir: string, relativePath: string) {
  const path = `${bundleDir}/${relativePath}`;
  assertInsideBundle(path, bundleDir);
  return path;
}

function assertInsideBundle(path: string, bundleDir: string) {
  if (!path.startsWith(`${bundleDir}/`)) {
    throw new Error("Agent bundle path escaped the current agent bundle.");
  }
}

function stripBundlePrefix(path: string, bundleDir: string) {
  const prefix = `${bundleDir}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

function normalizeAgentBundlePath(input: string) {
  const path = input.trim().replace(/^\/+/, "").split("/").filter(Boolean).join("/");
  if (!path || path.startsWith(".") || path.includes("..")) return null;
  return path;
}

function stripAgentSandboxPrefix(path: string) {
  return path.startsWith("agent/") ? path.slice("agent/".length) : path;
}

function dirname(path: string) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}
