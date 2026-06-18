import { agentBundleDir, shellQuote } from "@opencompany/agent-runtime";
import { recordBrainFileVersion } from "@opencompany/db/brain-versions";
import { agentFiles, agentSessionBundleMounts, agents } from "@opencompany/db/schema";
import { enqueueWorkspaceSync } from "@opencompany/db/sync-outbox";
import { createLogger } from "@opencompany/observability";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import { appendRuntimeEvent } from "./events";
import { conflictPath, hashContent } from "./repo-files";
import { type SandboxHandle, sandboxLayout, writeSandboxTextFiles } from "./sandbox";

// Personal-brain caps are intentionally MUCH larger than the company-brain caps. A user's
// "second brain" is the whole point of the personal surface; the old limits (inherited from the
// 256 KB/file + 2 MB-total company caps) silently truncated real imports — the core PRO-244
// data-loss bug. Decoupled and generous here, and anything still over-cap is now SURFACED via an
// agent_bundle.cap_exceeded event, never dropped silently. TODO(jasper): confirm these numbers.
export const MAX_AGENT_BUNDLE_FILE_BYTES = 2 * 1024 * 1024; // 2 MB per file
// Deliberately decoupled from MAX_BRAIN_MOUNT_FILES (80): structured memory creates many small
// files by design, so the byte budget is the real bound here. Sync cost stays O(changed files)
// because hashing happens in-sandbox (see syncAgentBundleFromSandbox).
export const MAX_AGENT_BUNDLE_MOUNT_FILES = 1000;
export const MAX_AGENT_BUNDLE_MOUNT_BYTES = 32 * 1024 * 1024; // 32 MB total bundle
// Profile file: always-present so the agent can read/edit it and so the runtime can inject it
// into the system prompt every session (see resolveAgentRuntimeConfig). Created empty when
// absent, exactly like a freshly-seeded scratchpad.
const AGENT_USER_MEMORY_PATH = "user.md";
const SANDBOX_USER = "user";
const logger = createLogger({ service: "opencompany-runner", runtime: "server" });

type AgentFileRow = typeof agentFiles.$inferSelect;

// Map a bundle-relative path (under agents/<slug>/, e.g. "memory/x.md", "personal-brain/y.md",
// "user.md", "skills/foo/SKILL.md") to its sandbox-relative path for the session layout. For a
// personal session, memory/ and personal-brain/ are promoted to the top level; everything else
// (profile, soul, skill authoring) stays under agent/. For company sessions everything is under
// agent/.
function bundleRelativeToSandboxRelative(relativePath: string, personal: boolean): string {
  if (personal && isTopLevelPersonalRoot(relativePath)) return relativePath;
  return `agent/${relativePath}`;
}

// Reverse of bundleRelativeToSandboxRelative. Returns null when the sandbox path is outside the
// agent's writable bundle roots (so unrelated files like work/ are never synced back).
function sandboxRelativeToBundleRelative(sandboxPath: string, personal: boolean): string | null {
  if (sandboxPath === "agent" || sandboxPath.startsWith("agent/")) {
    return sandboxPath.slice("agent/".length) || null;
  }
  if (personal && isTopLevelPersonalRoot(sandboxPath)) return sandboxPath;
  return null;
}

// Ordering used when the bundle caps force drops (both at materialization and sync): keep
// personal-brain notes and the agent's own files (user.md, soul.md, skill authoring) ahead of
// memory, and bulk memory evidence last — so growth in memory/evidence/ can never starve a
// personal-brain write or a canonical memory object. Alphabetical within each tier.
function bundleMountPriority(relativePath: string): number {
  if (relativePath === "personal-brain" || relativePath.startsWith("personal-brain/")) return 0;
  if (!(relativePath === "memory" || relativePath.startsWith("memory/"))) return 1;
  if (relativePath.startsWith("memory/evidence/")) return 3;
  return 2;
}

function compareBundleMountOrder(a: string, b: string): number {
  return bundleMountPriority(a) - bundleMountPriority(b) || a.localeCompare(b);
}

function isTopLevelPersonalRoot(path: string): boolean {
  return (
    path === "memory" ||
    path.startsWith("memory/") ||
    path === "personal-brain" ||
    path.startsWith("personal-brain/")
  );
}

// The writable bundle roots a session materializes into. Personal promotes memory/ and
// personal-brain/ to the top level alongside agent/; company uses agent/ only.
function bundleSandboxRoots(layout: ReturnType<typeof sandboxLayout>): string[] {
  if (layout.personal) {
    return [layout.agentRoot, layout.memoryRoot, layout.personalBrainRoot].filter(
      (root): root is string => Boolean(root),
    );
  }
  return [layout.agentRoot];
}

// Defensive guard: these roots drive a destructive `rm -rf`. workdir comes from a system-controlled
// session record, but refuse to run if a root ever resolves to a malformed path (empty, or not a
// child segment of the workdir).
function assertSafeDestructiveRoot(root: string, workdir: string) {
  if (!root || !root.startsWith(`${workdir}/`) || root === `${workdir}/`) {
    throw new Error(`Refusing destructive rm -rf on malformed bundle root: ${root}`);
  }
}

export async function materializeAgentBundleForSession(input: {
  sandbox: SandboxHandle;
  sessionId: string;
  workspaceId: string;
  agentId: string;
  workdir: string;
  personal?: boolean;
}) {
  const personal = input.personal ?? false;
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
    .sort((a, b) => compareBundleMountOrder(a.relativePath, b.relativePath));
  const { mounted: limitedFiles, dropped } = limitMountedAgentFiles(files);
  if (dropped.length > 0) {
    logger.warn("Agent bundle materialization dropped files over bundle caps", {
      session_id: input.sessionId,
      workspace_id: input.workspaceId,
      agent_id: input.agentId,
      dropped_count: dropped.length,
      sample_paths: dropped.slice(0, 10).map((file) => file.repoPath),
    });
    // Surface the truncation to the user instead of only logging it (PRO-244).
    await appendRuntimeEvent(db, {
      sessionId: input.sessionId,
      type: "agent_bundle.cap_exceeded",
      payload: {
        droppedPaths: dropped.slice(0, 50).map((file) => file.repoPath),
        droppedCount: dropped.length,
      },
    });
  }
  const layout = sandboxLayout(input.workdir, personal);
  const roots = bundleSandboxRoots(layout);

  for (const root of roots) {
    assertSafeDestructiveRoot(root, input.workdir);
  }
  const quotedRoots = roots.map(shellQuote).join(" ");
  await input.sandbox.commands.run(`rm -rf ${quotedRoots} && mkdir -p ${quotedRoots}`, {
    user: SANDBOX_USER,
    timeoutMs: 30_000,
  });

  const mountedPaths = new Set(limitedFiles.map((file) => file.relativePath));
  const materializedFiles: AgentBundleMaterializationFile[] = limitedFiles.map((file) => {
    const sandboxRelative = bundleRelativeToSandboxRelative(file.relativePath, personal);
    return {
      repoPath: file.repoPath,
      sandboxRelative,
      destination: `${input.workdir}/${sandboxRelative}`,
      content: file.content,
      contentHash: file.contentHash,
    };
  });
  if (!mountedPaths.has(AGENT_USER_MEMORY_PATH)) {
    const sandboxRelative = bundleRelativeToSandboxRelative(AGENT_USER_MEMORY_PATH, personal);
    materializedFiles.push({
      repoPath: repoPathFor(bundle.dir, AGENT_USER_MEMORY_PATH),
      sandboxRelative,
      destination: `${input.workdir}/${sandboxRelative}`,
      content: "",
      contentHash: hashContent(""),
    });
  }

  await writeSandboxTextFiles({
    sandbox: input.sandbox,
    files: materializedFiles.map((file) => ({ path: file.destination, content: file.content })),
    user: SANDBOX_USER,
  });
  await Promise.all(
    materializedFiles.map((file) =>
      mountAgentBundleFile({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        repoPath: file.repoPath,
        sandboxPath: file.sandboxRelative,
        contentHash: file.contentHash,
      }),
    ),
  );
}

type AgentBundleMaterializationFile = {
  repoPath: string;
  sandboxRelative: string;
  destination: string;
  content: string;
  contentHash: string;
};

export async function syncAgentBundleFromSandbox(input: {
  sandbox: SandboxHandle;
  sessionId: string;
  workspaceId: string;
  agentId: string;
  workdir: string;
  personal?: boolean;
}) {
  const personal = input.personal ?? false;
  const db = getDb();
  const bundle = await loadAgentBundle(input.workspaceId, input.agentId);
  const mounts = await db
    .select()
    .from(agentSessionBundleMounts)
    .where(eq(agentSessionBundleMounts.sessionId, input.sessionId));
  if (mounts.length === 0) return;

  // Personal sessions write to memory/ + personal-brain/ + agent/; company sessions to agent/ only.
  // List and hash all writable bundle roots in one round-trip (hashContent is sha256-hex over the
  // file bytes, so in-sandbox `sha256sum` output is directly comparable to the recorded mount
  // hashes). Per-turn cost then scales with the number of *changed* files — only those are read
  // back individually — not with bundle size.
  const listRoots = personal ? ["memory", "personal-brain", "agent"] : ["agent"];
  const findClause = listRoots
    .map(
      (root) => `if [ -d ${shellQuote(root)} ]; then find ${shellQuote(root)} -type f -print0; fi`,
    )
    .join("; ");
  const result = await input.sandbox.commands.run(
    `cd ${shellQuote(input.workdir)} && { ${findClause}; } | sort -z | xargs -0 -r sha256sum --`,
    { timeoutMs: 60_000 },
  );
  // Each entry keeps the raw sandbox path (for reading) alongside its bundle-relative path.
  // Priority order mirrors materialization so cap-driven drops hit bulk memory evidence first,
  // never personal-brain or the agent's own files.
  const entries = parseSandboxHashLines(String(result.stdout ?? ""))
    .map(({ sandboxPath, hash }) => {
      const bundleRelative = sandboxRelativeToBundleRelative(sandboxPath, personal);
      const normalized = bundleRelative ? normalizeAgentBundlePath(bundleRelative) : null;
      return normalized ? { sandboxPath, relativePath: normalized, sandboxHash: hash } : null;
    })
    .filter((entry): entry is { sandboxPath: string; relativePath: string; sandboxHash: string } =>
      Boolean(entry),
    )
    .sort((a, b) => compareBundleMountOrder(a.relativePath, b.relativePath));
  const sandboxPathSet = new Set(entries.map((entry) => entry.relativePath));
  const fileMounts = mounts.filter((mount) => mount.referenceType === "file");
  const mountByPath = new Map(fileMounts.map((mount) => [mount.path, mount]));
  // One snapshot of the persisted bundle: sizes for cap accounting of unchanged files, and the
  // current rows for conflict detection (replaces the old per-file SELECTs).
  const currentRows = await db
    .select()
    .from(agentFiles)
    .where(
      and(eq(agentFiles.workspaceId, input.workspaceId), eq(agentFiles.agentId, input.agentId)),
    );
  const currentByPath = new Map(currentRows.map((row) => [row.path, row]));
  // The caps bound the whole persisted bundle, so unchanged files count toward them too — but
  // a file over the cap is dropped loudly (logged below) instead of the old silent `break`.
  let bundleFiles = 0;
  let bundleBytes = 0;
  const droppedPaths: string[] = [];

  for (const { sandboxPath, relativePath, sandboxHash } of entries) {
    const repoPath = repoPathFor(bundle.dir, relativePath);
    assertInsideBundle(repoPath, bundle.dir);
    const mount = mountByPath.get(repoPath);
    if (mount?.lastSyncedHash === sandboxHash) {
      // Unchanged since the last sync — already persisted, nothing to read or write.
      bundleFiles += 1;
      bundleBytes += currentByPath.get(repoPath)?.sizeBytes ?? 0;
      continue;
    }
    if (bundleFiles >= MAX_AGENT_BUNDLE_MOUNT_FILES) {
      droppedPaths.push(repoPath);
      continue;
    }
    // A file can be deleted/become unreadable between the listing above and
    // this read. Skip it rather than aborting the whole sync.
    let content: string;
    try {
      content = await input.sandbox.files.read(`${input.workdir}/${sandboxPath}`);
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
    if (
      sizeBytes > MAX_AGENT_BUNDLE_FILE_BYTES ||
      bundleBytes + sizeBytes > MAX_AGENT_BUNDLE_MOUNT_BYTES
    ) {
      droppedPaths.push(repoPath);
      continue;
    }
    bundleFiles += 1;
    bundleBytes += sizeBytes;
    const hash = hashContent(content);
    // Re-hash after reading: the decoded content is authoritative (and e.g. non-UTF-8 bytes can
    // hash differently in-sandbox than after decoding).
    if (mount?.lastSyncedHash === hash) continue;

    const current = currentByPath.get(repoPath);
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
      sessionId: input.sessionId,
      previous:
        current && targetPath === repoPath
          ? {
              content: current.content,
              contentHash: current.contentHash,
              sizeBytes: current.sizeBytes,
            }
          : null,
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
        requestedPath: sandboxPath,
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
    const current = currentByPath.get(mount.path);
    if (current && current.contentHash !== mount.baseHash) {
      await appendRuntimeEvent(db, {
        sessionId: input.sessionId,
        type: "agent_bundle.conflict",
        payload: { path: mount.path, operation: "delete_conflict" },
      });
      continue;
    }
    await db.transaction(async (tx) => {
      // Preserve the deleted content before the row is gone.
      if (current) {
        await recordBrainFileVersion(tx, {
          workspaceId: input.workspaceId,
          scope: "personal",
          agentId: input.agentId,
          path: mount.path,
          content: current.content,
          contentHash: current.contentHash,
          sizeBytes: current.sizeBytes,
          operation: "delete",
          sessionId: input.sessionId,
        });
      }
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

  if (droppedPaths.length > 0) {
    logger.warn("Agent bundle sync dropped files over bundle caps", {
      session_id: input.sessionId,
      workspace_id: input.workspaceId,
      agent_id: input.agentId,
      dropped_count: droppedPaths.length,
      sample_paths: droppedPaths.slice(0, 10),
    });
    // Surface to the user — a silent log here is exactly how the migration vanished (PRO-244).
    await appendRuntimeEvent(db, {
      sessionId: input.sessionId,
      type: "agent_bundle.cap_exceeded",
      payload: {
        droppedPaths: droppedPaths.slice(0, 50),
        droppedCount: droppedPaths.length,
      },
    });
  }
}

// `sha256sum` emits "<64-hex>  <path>" (or " *<path>" in binary mode) per file. Lines that do
// not parse (e.g. coreutils' backslash-escaped form for filenames with newlines) are skipped —
// such names can't round-trip through the bundle anyway.
const SHA256_LINE = /^([0-9a-f]{64}) [ *](.+)$/;

function parseSandboxHashLines(stdout: string): Array<{ sandboxPath: string; hash: string }> {
  return stdout
    .split("\n")
    .map((line) => {
      const match = SHA256_LINE.exec(line);
      return match ? { hash: match[1] as string, sandboxPath: match[2] as string } : null;
    })
    .filter((entry): entry is { sandboxPath: string; hash: string } => Boolean(entry));
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
  // The file's actual sandbox-relative path (e.g. "agent/user.md", "memory/x.md") — informational,
  // used for conflict/mount bookkeeping.
  sandboxPath: string;
  contentHash: string;
}) {
  await getDb()
    .insert(agentSessionBundleMounts)
    .values({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      requestedPath: input.sandboxPath,
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
  sessionId: string | null;
  previous: { content: string; contentHash: string; sizeBytes: number } | null;
}) {
  const db = getDb();
  const sizeBytes = Buffer.byteLength(input.content, "utf8");
  const now = new Date();

  await db.transaction(async (tx) => {
    // Back up the bytes we are about to overwrite so the change is recoverable.
    if (input.previous && input.previous.contentHash !== input.contentHash) {
      await recordBrainFileVersion(tx, {
        workspaceId: input.workspaceId,
        scope: "personal",
        agentId: input.agentId,
        path: input.path,
        content: input.previous.content,
        contentHash: input.previous.contentHash,
        sizeBytes: input.previous.sizeBytes,
        operation: "overwrite",
        sessionId: input.sessionId,
      });
    }
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
  const dropped: MountedAgentFile[] = [];
  let bytes = 0;

  for (const file of files) {
    if (
      file.sizeBytes > MAX_AGENT_BUNDLE_FILE_BYTES ||
      mounted.length >= MAX_AGENT_BUNDLE_MOUNT_FILES ||
      bytes + file.sizeBytes > MAX_AGENT_BUNDLE_MOUNT_BYTES
    ) {
      dropped.push(file);
      continue;
    }
    mounted.push(file);
    bytes += file.sizeBytes;
  }

  return { mounted, dropped };
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
