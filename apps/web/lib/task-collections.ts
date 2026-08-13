import type { GoatChatMessageAttachment } from "@opencompany/goat-agent/chat-attachment-formats";
import type {
  GoatTaskEventType,
  GoatTaskMessageRole,
  GoatTaskMessageStatus,
  GoatTaskReportedOutcome,
  GoatTaskStage,
  GoatTaskStatus,
  GoatTaskToolName,
} from "@opencompany/goat-agent/task-runtime-types";
import { createGoatElectricCollection } from "@/lib/electric-collection";

type ElectricNumber = number | string;

type GoatIntegrationProvider =
  | "gmail"
  | "google_calendar"
  | "google_drive"
  | "linear"
  | "github"
  | "jamie"
  | "slack"
  | "slack_bot"
  | "hubspot"
  | "granola"
  | "fathom"
  | "attio"
  | "stripe"
  | "latitude"
  | "posthog"
  | "neon"
  | "imessage"
  | "x_account";
type GoatIntegrationStatus = "connected" | "needs_reauth" | "sync_failed" | "disconnected";

export type GoatTaskRow = {
  id: string;
  display_id: string;
  name: string;
  user_workos_id: string;
  workspace_id: string | null;
  prompt: string;
  model: string;
  engine?: "opencompany" | "codex" | "claude_code";
  session_id: string | null;
  schedule_id: string | null;
  scheduled_for: string | null;
  workflow_id: string | null;
  workflow_brain_ref: string | null;
  status: GoatTaskStatus;
  stage: GoatTaskStage;
  result: string | null;
  error: string | null;
  reported_outcome: GoatTaskReportedOutcome | null;
  outcome_comment: string | null;
  harness_spec: unknown;
  debug_trace: unknown;
  sandbox_id: string | null;
  attempts: number;
  next_run_at: string;
  lease_id: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type GoatChatMessageRow = {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  task_id: string | null;
  debug_trace: Record<string, unknown> | null;
  attachments: GoatChatMessageAttachment[] | null;
  created_at: string;
  updated_at: string;
};

export type GoatChatSessionRow = {
  id: string;
  user_workos_id: string;
  title: string;
  model: string;
  engine: "opencompany" | "codex" | "claude_code";
  kind: "chat" | "task";
  closed_at: string | null;
  pinned_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};

export type GoatCodexChatSessionRow = {
  id: string;
  user_workos_id: string;
  chat_session_id: string;
  model: string;
  active_turn_id: string | null;
  status: "queued" | "starting" | "idle" | "running" | "failed" | "interrupted" | "closed";
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type GoatTaskMessageRow = {
  id: string;
  task_id: string;
  user_workos_id: string;
  role: GoatTaskMessageRole;
  status: GoatTaskMessageStatus;
  content: string;
  model_message: unknown | null;
  tool_name: GoatTaskToolName | null;
  tool_call_id: string | null;
  response_to_message_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type GoatTaskEventRow = {
  id: number;
  task_id: string;
  user_workos_id: string;
  message_id: string | null;
  type: GoatTaskEventType;
  payload: Record<string, unknown>;
  created_at: string;
};

export type GoatTaskModelUsageRow = {
  id: number;
  task_id: string;
  user_workos_id: string;
  message_id: string | null;
  run_lease_id: string | null;
  phase: string;
  step_index: number;
  model_provider: string;
  model_name: string;
  response_id: string | null;
  response_model_id: string | null;
  finish_reason: string | null;
  raw_finish_reason: string | null;
  input_tokens: ElectricNumber;
  input_no_cache_tokens: ElectricNumber;
  input_cache_read_tokens: ElectricNumber;
  input_cache_write_tokens: ElectricNumber;
  output_tokens: ElectricNumber;
  output_text_tokens: ElectricNumber;
  output_reasoning_tokens: ElectricNumber;
  total_tokens: ElectricNumber;
  raw_usage: Record<string, unknown>;
  provider_created_at: string | null;
  provider_cost_usd_micros: ElectricNumber;
  platform_fee_usd_micros: ElectricNumber;
  total_cost_usd_micros: ElectricNumber;
  cost_basis: Record<string, unknown>;
  created_at: string;
};

export type GoatTaskToolUsageRow = {
  id: number;
  task_id: string;
  user_workos_id: string;
  message_id: string | null;
  run_lease_id: string | null;
  tool_call_id: string;
  tool_name: string;
  provider: string;
  operation: string;
  provider_request_id: string | null;
  provider_cost_usd_micros: ElectricNumber;
  platform_fee_usd_micros: ElectricNumber;
  total_cost_usd_micros: ElectricNumber;
  raw_usage: Record<string, unknown>;
  cost_basis: Record<string, unknown>;
  created_at: string;
};

export type GoatTaskSandboxUsageRow = {
  id: number;
  task_id: string;
  user_workos_id: string;
  message_id: string | null;
  run_lease_id: string | null;
  sandbox_id: string;
  template: string | null;
  vcpu: number | null;
  ram_mib: number | null;
  started_at: string | null;
  ended_at: string | null;
  active_ms: ElectricNumber;
  provider_cost_usd_micros: ElectricNumber;
  platform_fee_usd_micros: ElectricNumber;
  total_cost_usd_micros: ElectricNumber;
  raw_metrics: Record<string, unknown>;
  cost_basis: Record<string, unknown>;
  created_at: string;
};

export type GoatIntegrationRow = {
  id: string;
  user_workos_id: string;
  workspace_id: string | null;
  shared_with_workspace: boolean;
  provider: GoatIntegrationProvider;
  external_id: string;
  connection_label: string | null;
  account_name: string | null;
  account_email: string | null;
  account_type: string | null;
  status: GoatIntegrationStatus;
  status_reason: string | null;
  scopes: string[];
  capability_modes: Record<string, unknown>;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

function createChatMessageCollection(sessionId: string) {
  return createGoatElectricCollection<GoatChatMessageRow>({
    id: `goat:chat_messages:${sessionId}`,
    table: "goat.chat_messages",
    params: { session_id: sessionId },
    getKey: (row) => row.id,
  });
}

const chatMessageCollectionsBySessionId = new Map<
  string,
  ReturnType<typeof createChatMessageCollection>
>();
function getChatMessageCollection(sessionId: string) {
  const cached = chatMessageCollectionsBySessionId.get(sessionId);
  if (cached) return cached;

  const collection = createChatMessageCollection(sessionId);
  chatMessageCollectionsBySessionId.set(sessionId, collection);
  return collection;
}

function buildGoatCollections() {
  const chatSessions = createGoatElectricCollection<GoatChatSessionRow>({
    id: "goat:chat_sessions",
    table: "goat.chat_sessions",
    getKey: (row) => row.id,
  });

  const codexChatSessions = createGoatElectricCollection<GoatCodexChatSessionRow>({
    id: "goat:codex_chat_sessions",
    table: "goat.codex_chat_sessions",
    getKey: (row) => row.id,
  });

  const integrations = createGoatElectricCollection<GoatIntegrationRow>({
    id: "goat:integrations",
    table: "goat.integrations",
    getKey: (row) => row.id,
  });

  return {
    chatSessions,
    chatMessages: getChatMessageCollection,
    codexChatSessions,
    integrations,
  };
}

let cachedGoatCollections: ReturnType<typeof buildGoatCollections> | null = null;

export function createGoatCollections() {
  cachedGoatCollections ??= buildGoatCollections();
  return cachedGoatCollections;
}

export const createGoatTaskCollections = createGoatCollections;

export type GoatCollections = ReturnType<typeof createGoatCollections>;
export type GoatTaskCollections = GoatCollections;
