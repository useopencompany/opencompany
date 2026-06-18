import { recordBrainFileVersion } from "@opencompany/db/brain-versions";
import { agentFiles, brainFiles, brainFileVersions } from "@opencompany/db/schema";
import { enqueueWorkspaceSync } from "@opencompany/db/sync-outbox";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "./db";
import { appendRuntimeEvent } from "./events";

// restore_brain_file (kind: "internal") runs in the runner, not the sandbox. It rolls a brain
// knowledge file back to a previously-captured version (PRO-244 durability floor). Every overwrite
// or delete the runner makes first records the displaced bytes into brain_file_versions; this tool
// reads that history and writes a chosen version back as the canonical content.
//
// Scope is the single most error-prone detail (see KEY CORRECTNESS RULES):
//   - COMPANY brain  -> brainFiles, keyed by the LOGICAL path (brainFiles.path, no "brain/" prefix).
//                       Sync source kind "brain"; repo path is "brain/<logical>".
//   - PERSONAL brain -> agentFiles, keyed by the FULL repo path (agents/<slug>/personal-brain/...).
//                       Sync source kind "agent_file"; repo path IS that full path.
//
// The restore is itself undoable: before writing the restored content we record the CURRENT live
// content as a new "overwrite" version (skipped only when the live hash already equals the restored
// hash — a no-op). Restoring a version whose operation was "delete" simply re-creates the file.

const BRAIN_REPO_PREFIX = "brain/";

type BrainScope = "personal" | "company";

type RecoverableResult = {
  ok: false;
  error: { message: string; code: string; recoverable: boolean };
};

function recoverable(code: string, message: string): RecoverableResult {
  return { ok: false, error: { message, code, recoverable: true } };
}

function brainRepoPath(path: string) {
  return `${BRAIN_REPO_PREFIX}${path}`;
}

type VersionRow = typeof brainFileVersions.$inferSelect;

// Read the version history for one path in the right scope, newest first. Company scope is keyed by
// the logical brain path; personal scope by the full agentFiles repo path — and additionally pinned
// to the owning agentId so one agent can never see/restore another's personal-brain history.
async function listVersionsForPath(input: {
  db: ReturnType<typeof getDb>;
  workspaceId: string;
  scope: BrainScope;
  agentId: string | null;
  path: string;
}): Promise<VersionRow[]> {
  const conditions = [
    eq(brainFileVersions.workspaceId, input.workspaceId),
    eq(brainFileVersions.scope, input.scope),
    eq(brainFileVersions.path, input.path),
  ];
  if (input.scope === "personal" && input.agentId) {
    conditions.push(eq(brainFileVersions.agentId, input.agentId));
  }
  return input.db
    .select()
    .from(brainFileVersions)
    .where(and(...conditions))
    .orderBy(desc(brainFileVersions.createdAt), desc(brainFileVersions.id));
}

export async function runRestoreBrainTool(input: {
  sessionId: string;
  workspaceId: string;
  agentId: string | null | undefined;
  personalAgent: boolean;
  args: unknown;
}): Promise<unknown> {
  const args = (input.args ?? {}) as Record<string, unknown>;
  const path = typeof args.path === "string" ? args.path.trim() : "";
  const versionId =
    typeof args.version_id === "number" && Number.isInteger(args.version_id)
      ? args.version_id
      : undefined;
  const sessionFilter = typeof args.session_id === "string" ? args.session_id.trim() : "";
  const listOnly = args.list_only === true;

  if (!path) {
    return recoverable("invalid_tool_input", "restore_brain_file requires a non-empty `path`.");
  }

  const scope: BrainScope = input.personalAgent ? "personal" : "company";
  const agentId = input.agentId ?? null;
  // Personal restore needs an owning agent to scope the agentFiles row + version history. Without
  // it we would either touch the wrong file or leak another agent's history, so refuse loudly.
  if (scope === "personal" && !agentId) {
    return recoverable(
      "missing_agent",
      "Restoring a personal-brain file requires an agent context, which is missing in this run.",
    );
  }

  const db = getDb();
  const versions = await listVersionsForPath({
    db,
    workspaceId: input.workspaceId,
    scope,
    agentId,
    path,
  });

  if (listOnly) {
    return {
      ok: true,
      scope,
      path,
      versions: versions.map((version) => ({
        id: version.id,
        operation: version.operation,
        sizeBytes: version.sizeBytes,
        sessionId: version.sessionId,
        createdAt:
          version.createdAt instanceof Date
            ? version.createdAt.toISOString()
            : String(version.createdAt),
      })),
      message: versions.length
        ? `Found ${versions.length} saved version(s) for "${path}".`
        : `No saved versions for "${path}". Nothing to restore.`,
    };
  }

  // Pick the target version: an explicit id wins; else the most recent matching the optional
  // session_id grouping; else the single most-recent version for the path.
  let target: VersionRow | undefined;
  if (versionId !== undefined) {
    target = versions.find((version) => version.id === versionId);
    if (!target) {
      return recoverable(
        "version_not_found",
        `No saved version with id ${versionId} exists for "${path}" in the ${scope} brain. Call restore_brain_file with list_only=true to see the available versions.`,
      );
    }
  } else if (sessionFilter) {
    target = versions.find((version) => version.sessionId === sessionFilter);
    if (!target) {
      return recoverable(
        "version_not_found",
        `No saved version from session "${sessionFilter}" exists for "${path}". Call restore_brain_file with list_only=true to see the available versions.`,
      );
    }
  } else {
    target = versions[0];
  }
  if (!target) {
    return recoverable(
      "version_not_found",
      `There is no saved version history for "${path}" yet, so there is nothing to restore.`,
    );
  }

  const restoredContent = target.content;
  const restoredHash = target.contentHash;
  const sizeBytes = Buffer.byteLength(restoredContent, "utf8");
  const now = new Date();
  const repoPath = scope === "company" ? brainRepoPath(path) : path;
  const sourceKind = scope === "company" ? "brain" : "agent_file";

  await db.transaction(async (tx) => {
    // Read the CURRENT live row so we can (a) back it up before clobbering it and (b) detect a
    // no-op restore. Company keys by logical path; personal keys by full repo path (+ agentId).
    const current =
      scope === "company"
        ? (
            await tx
              .select()
              .from(brainFiles)
              .where(and(eq(brainFiles.workspaceId, input.workspaceId), eq(brainFiles.path, path)))
              .limit(1)
          )[0]
        : (
            await tx
              .select()
              .from(agentFiles)
              .where(
                and(
                  eq(agentFiles.workspaceId, input.workspaceId),
                  eq(agentFiles.path, path),
                  ...(agentId ? [eq(agentFiles.agentId, agentId)] : []),
                ),
              )
              .limit(1)
          )[0];

    // The restore is itself undoable: preserve the live bytes as a new "overwrite" version unless
    // restoring would be a no-op (live content already matches the chosen version).
    if (current && current.contentHash !== restoredHash) {
      await recordBrainFileVersion(tx, {
        workspaceId: input.workspaceId,
        scope,
        agentId: scope === "personal" ? agentId : null,
        path,
        content: current.content,
        contentHash: current.contentHash,
        sizeBytes: current.sizeBytes,
        operation: "overwrite",
        sessionId: input.sessionId,
      });
    }

    if (scope === "company") {
      await tx
        .insert(brainFiles)
        .values({
          workspaceId: input.workspaceId,
          path,
          content: restoredContent,
          contentHash: restoredHash,
          sizeBytes,
          githubSyncStatus: "pending",
          githubSyncError: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [brainFiles.workspaceId, brainFiles.path],
          set: {
            content: restoredContent,
            contentHash: restoredHash,
            sizeBytes,
            githubSyncStatus: "pending",
            githubSyncError: null,
            updatedAt: now,
          },
        });
    } else {
      await tx
        .insert(agentFiles)
        .values({
          workspaceId: input.workspaceId,
          agentId: agentId as string,
          path,
          content: restoredContent,
          contentHash: restoredHash,
          sizeBytes,
          githubSyncStatus: "pending",
          githubSyncError: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [agentFiles.workspaceId, agentFiles.path],
          set: {
            agentId: agentId as string,
            content: restoredContent,
            contentHash: restoredHash,
            sizeBytes,
            githubSyncStatus: "pending",
            githubSyncError: null,
            updatedAt: now,
          },
        });
    }

    await enqueueWorkspaceSync(tx, {
      workspaceId: input.workspaceId,
      repoPath,
      sourceKind,
      operation: "upsert",
      desiredHash: restoredHash,
    });
  });

  // Surface the restore on the same event the runner uses for any brain/bundle write so the UI
  // reflects the changed file. appendRuntimeEvent takes the top-level db (mirrors brain.ts).
  await appendRuntimeEvent(db, {
    sessionId: input.sessionId,
    ...(scope === "company"
      ? {
          type: "brain.file_changed" as const,
          payload: { path, savedPath: path, operation: "write" as const },
        }
      : {
          type: "agent_bundle.file_changed" as const,
          payload: { path, savedPath: path, operation: "write" as const },
        }),
  });

  return {
    ok: true,
    scope,
    path,
    restored: {
      versionId: target.id,
      operation: target.operation,
      sizeBytes,
      sessionId: target.sessionId,
    },
    message:
      target.operation === "delete"
        ? `Re-created "${path}" from the saved version before it was deleted.`
        : `Restored "${path}" to the saved version from ${
            target.sessionId ? `session ${target.sessionId}` : "an earlier turn"
          }.`,
  };
}
