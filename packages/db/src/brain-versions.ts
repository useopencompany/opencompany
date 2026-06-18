import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";
import { brainFileVersions } from "./schema";

export type BrainFileVersionScope = "personal" | "company";
export type BrainFileVersionOperation = "overwrite" | "delete";

export type RecordBrainFileVersionInput = {
  workspaceId: string;
  scope: BrainFileVersionScope;
  /** Owning agent for personal scope; null for company brain. */
  agentId: string | null;
  /** Canonical repo path of the file whose prior content we are preserving. */
  path: string;
  /** The content being displaced (the OLD bytes), not the new ones. */
  content: string;
  contentHash: string;
  sizeBytes: number;
  operation: BrainFileVersionOperation;
  /** Session/turn that displaced the content; the "step back a turn" grouping key. */
  sessionId: string | null;
};

// Capture the prior content of a brain file before it is overwritten or
// deleted, so the change is always recoverable (PRO-244). Like
// `enqueueWorkspaceSync`, this lives in @opencompany/db so both the runner
// (pooled node-postgres) and the web app (neon-http) call it identically, and
// it RETURNS the insert query builder rather than executing it — callers pass
// the surrounding transaction (`tx`) so the version row commits atomically with
// the mutation that displaced it, and `await` the result.
export function recordBrainFileVersion<TQuery extends PgQueryResultHKT>(
  db: Pick<PgDatabase<TQuery, typeof schema>, "insert">,
  input: RecordBrainFileVersionInput,
) {
  return db.insert(brainFileVersions).values({
    workspaceId: input.workspaceId,
    scope: input.scope,
    agentId: input.agentId,
    path: input.path,
    content: input.content,
    contentHash: input.contentHash,
    sizeBytes: input.sizeBytes,
    operation: input.operation,
    sessionId: input.sessionId,
  });
}
