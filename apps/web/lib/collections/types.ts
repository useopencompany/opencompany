import type { AgentConfig, TiptapDoc } from "@opencompany/agent-runtime/types";
import type { InboxItemArtifact } from "@opencompany/db/schema";

/**
 * Raw rows as ElectricSQL syncs them out of Postgres. Keys are the Postgres
 * column names (snake_case). Electric's client parses int/float/bool/json by
 * default; timestamptz values arrive as ISO strings (we coerce in selectors,
 * not here, to keep the synced store a faithful mirror of the table).
 *
 * Derivation into the app's camelCase payload shapes happens in live-query
 * selectors — these types are the boundary contract, nothing more.
 */

export type AgentRow = {
  id: string;
  workspace_id: string;
  path: string | null;
  name: string;
  body: string;
  commit_sha: string | null;
  content_hash: string | null;
  version: number;
  github_blob_sha: string | null;
  github_commit_sha: string | null;
  github_synced_hash: string | null;
  github_synced_at: string | null;
  github_sync_status: string;
  github_sync_error: string | null;
  content: TiptapDoc;
  config: AgentConfig;
  created_at: string;
  updated_at: string;
};

export type AgentSessionRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  agent_id: string;
  title: string;
  status: string;
  source: "user" | "agent";
  model_provider: string;
  model_name: string;
  parent_session_id: string | null;
  parent_message_id: string | null;
  parent_tool_call_id: string | null;
  e2b_sandbox_id: string | null;
  workdir: string;
  last_error: string | null;
  abort_requested_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SessionStarRow = {
  user_id: string;
  session_id: string;
  starred_at: string;
};

// Only live items (status open/snoozed) are synced into this shape; resolved items leave it.
export type InboxItemRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  source_session_id: string | null;
  source: string | null;
  title: string;
  body: string | null;
  steps: string[] | null;
  priority: "urgent" | "high" | "med" | "low" | null;
  due_at: string | null;
  artifact: InboxItemArtifact | null;
  status: "open" | "snoozed" | "done" | "dismissed";
  snoozed_until: string | null;
  dedup_key: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};
