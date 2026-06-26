import { BRAIN_SYNC_DELAY_MS } from "@opencompany/agent-runtime";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { workspaceSyncJobs } from "./schema";

// Shared workspace-projection enqueue helper. Lives in @opencompany/db so both
// the web app (neon-http driver) and the runner (pooled node-postgres driver)
// call exactly one upsert with identical coalescing semantics. It depends only
// on the schema + a shared constant — no database client — so importing it from
// the runner does not pull the web neon-http client.
//
// Like the brain/agent sync-job helpers it replaces, this RETURNS the insert
// query builder rather than executing it: web callers compose it into
// `db.batch([...])` alongside the canonical content write; the runner awaits it
// directly. Coalescing is keyed on (workspaceId, repoPath) so rapid successive
// edits to the same path collapse into a single pending job.

export type WorkspaceSyncSourceKind = "brain" | "agent" | "agent_file" | "skill";
export type WorkspaceSyncOperation = "upsert" | "delete";

export type EnqueueWorkspaceSyncInput = {
  workspaceId: string;
  repoPath: string;
  sourceKind: WorkspaceSyncSourceKind;
  operation: WorkspaceSyncOperation;
  /** Content hash of the desired state. Null for deletes. */
  desiredHash: string | null;
  /** Where the projector reads desired content (agentId for "agent", else null). */
  sourceRef?: string | null;
  /** Prior repo path for renames, so the projector emits a delete tree entry. */
  previousPath?: string | null;
  /** Prior GitHub blob SHA, carried for rename/delete bookkeeping. */
  previousBlobSha?: string | null;
  /** Override the coalesce delay before the row becomes due. */
  delayMs?: number;
  /** Override "now" (for deterministic callers/tests). Defaults to new Date(). */
  now?: Date;
};

export function enqueueWorkspaceSync<TQuery extends PgQueryResultHKT>(
  db: Pick<PgDatabase<TQuery, typeof schema>, "insert">,
  input: EnqueueWorkspaceSyncInput,
) {
  const now = input.now ?? new Date();
  const nextRunAt = new Date(now.getTime() + (input.delayMs ?? BRAIN_SYNC_DELAY_MS));
  return db
    .insert(workspaceSyncJobs)
    .values({
      workspaceId: input.workspaceId,
      repoPath: input.repoPath,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef ?? null,
      operation: input.operation,
      desiredHash: input.desiredHash,
      previousPath: input.previousPath ?? null,
      previousBlobSha: input.previousBlobSha ?? null,
      nextRunAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [workspaceSyncJobs.workspaceId, workspaceSyncJobs.repoPath],
      set: {
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef ?? null,
        operation: input.operation,
        desiredHash: input.desiredHash,
        previousPath: input.previousPath ?? null,
        previousBlobSha: input.previousBlobSha ?? null,
        attempts: 0,
        status: "pending",
        nextRunAt,
        lastError: null,
        updatedAt: now,
      },
    });
}
