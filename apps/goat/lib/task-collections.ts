import type {
  GoatBrainFolderSource,
  GoatBrainImportDiscoverySummary,
  GoatBrainImportSourceSelection,
  GoatBrainImportStatus,
  GoatChatMessageAttachment,
  GoatIntegrationProvider,
  GoatIntegrationStatus,
  GoatTaskEventType,
  GoatTaskMessageRole,
  GoatTaskMessageStatus,
  GoatTaskReportedOutcome,
  GoatTaskStage,
  GoatTaskStatus,
  GoatTaskToolName,
} from "@opencompany/db/goat-schema";
import { createGoatElectricCollection } from "@/lib/electric-collection";

type ElectricNumber = number | string;

export type GoatTaskRow = {
  id: string;
  display_id: string;
  name: string;
  user_workos_id: string;
  prompt: string;
  model: string;
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

export type GoatTaskScheduleRow = {
  id: string;
  user_workos_id: string;
  name: string;
  source_description: string;
  cron: string;
  timezone: string;
  prompt: string;
  planned_harness_spec: unknown;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string;
  deleted_at: string | null;
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
  status: "queued" | "starting" | "idle" | "running" | "failed" | "interrupted" | "closed";
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type GoatBrainFolderRow = {
  id: string;
  user_workos_id: string;
  brain_ref: string;
  path: string;
  source: GoatBrainFolderSource;
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

export type GoatBrainDocumentRow = {
  id: string;
  user_workos_id: string;
  created_by_workos_id: string | null;
  brain_ref: string;
  brain_id: string;
  folder_path: string;
  title: string | null;
  content: string;
  body: string;
  timeline: Array<{
    evidenceId?: string;
    evidence_id?: string;
    at: string;
    body: string;
  }>;
  format: string;
  mime_type: string | null;
  original_file_name: string | null;
  asset_storage_key: string | null;
  asset_size_bytes: number | null;
  relations: Array<{ type: string; to: string }>;
  sources: Array<{
    ref: string;
    capturedAt?: string;
    captured_at?: string;
    title?: string;
  }>;
  content_hash: string;
  size_bytes: number;
  kind: string;
  entity_type: string;
  status: string;
  aliases: string[];
  created_at: string;
  updated_at: string;
};

export type GoatBrainTimelineEntryRow = {
  id: number;
  document_id: string;
  user_workos_id: string;
  brain_ref: string;
  brain_id: string;
  evidence_id: string;
  at: string;
  source_ref: string;
  source_title: string | null;
  summary: string;
  detail: string;
  created_at: string;
};

export type GoatBrainEdgeRow = {
  id: string;
  user_workos_id: string;
  brain_ref: string;
  document_id: string;
  from_brain_id: string;
  to_brain_id: string;
  relation_type: string;
  source_kind: "relation" | "wiki_link";
  created_at: string;
  updated_at: string;
};

export type GoatBrainIngestJobRow = {
  id: string;
  source_item_id: string;
  user_workos_id: string;
  source_provider: string;
  source_connection_id: string;
  integration_id: string | null;
  import_run_id?: string | null;
  brain_ref: string | null;
  kind: string;
  content_hash: string;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  plan_paused: boolean;
  attempts: number;
  next_run_at: string;
  lease_id: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  result: Record<string, unknown>;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type GoatBrainImportRunRow = {
  id: string;
  brain_ref: string;
  user_workos_id: string;
  company_url: string;
  company_domain: string;
  company_name: string | null;
  focus: string | null;
  history_start_at: string;
  history_end_at: string;
  source_selection: GoatBrainImportSourceSelection;
  discovery_summary: GoatBrainImportDiscoverySummary;
  result: Record<string, unknown>;
  status: GoatBrainImportStatus;
  next_run_at: string;
  lease_id: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  confirmed_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

// Slim projection: the shape proxy strips the raw/normalized payload columns.
export type GoatBrainSourceItemRow = {
  id: string;
  user_workos_id: string;
  source_provider: string;
  source_type: string;
  external_id: string;
  title: string | null;
  occurred_at: string;
  captured_at: string;
  content_hash: string;
  last_ingest_job_id: string | null;
  last_ingest_status: string | null;
  last_ingest_error: string | null;
  last_ingested_at: string | null;
  created_at: string;
  updated_at: string;
};

function createTaskRunCollections(taskId: string) {
  return {
    messages: createGoatElectricCollection<GoatTaskMessageRow>({
      id: `goat:task_messages:${taskId}`,
      table: "goat.task_messages",
      params: { task_id: taskId },
      getKey: (row) => row.id,
    }),
    events: createGoatElectricCollection<GoatTaskEventRow>({
      id: `goat:task_events:${taskId}`,
      table: "goat.task_events",
      params: { task_id: taskId },
      getKey: (row) => row.id,
    }),
    modelUsage: createGoatElectricCollection<GoatTaskModelUsageRow>({
      id: `goat:task_model_usage:${taskId}`,
      table: "goat.task_model_usage",
      params: { task_id: taskId },
      getKey: (row) => row.id,
    }),
    toolUsage: createGoatElectricCollection<GoatTaskToolUsageRow>({
      id: `goat:task_tool_usage:${taskId}`,
      table: "goat.task_tool_usage",
      params: { task_id: taskId },
      getKey: (row) => row.id,
    }),
    sandboxUsage: createGoatElectricCollection<GoatTaskSandboxUsageRow>({
      id: `goat:task_sandbox_usage:${taskId}`,
      table: "goat.task_sandbox_usage",
      params: { task_id: taskId },
      getKey: (row) => row.id,
    }),
  };
}

// The Electric shape proxy authorizes the brain_ref param against the current
// user before forwarding, so each brain gets its own shape subscription.
function createBrainCollections(brainRef: string) {
  return {
    folders: createGoatElectricCollection<GoatBrainFolderRow>({
      id: `goat:brain_folders:${brainRef}`,
      table: "goat.brain_folders",
      params: { brain_ref: brainRef },
      getKey: (row) => row.id,
    }),
    documents: createGoatElectricCollection<GoatBrainDocumentRow>({
      id: `goat:brain_documents:${brainRef}`,
      table: "goat.brain_documents",
      params: { brain_ref: brainRef },
      getKey: (row) => row.id,
    }),
    timelineEntries: createGoatElectricCollection<GoatBrainTimelineEntryRow>({
      id: `goat:brain_timeline_entries:${brainRef}`,
      table: "goat.brain_timeline_entries",
      params: { brain_ref: brainRef },
      getKey: (row) => row.id,
    }),
    edges: createGoatElectricCollection<GoatBrainEdgeRow>({
      id: `goat:brain_edges:${brainRef}`,
      table: "goat.brain_edges",
      params: { brain_ref: brainRef },
      getKey: (row) => row.id,
    }),
    ingestJobs: createGoatElectricCollection<GoatBrainIngestJobRow>({
      id: `goat:brain_ingest_jobs:${brainRef}`,
      table: "goat.brain_ingest_jobs",
      params: { brain_ref: brainRef },
      getKey: (row) => row.id,
    }),
    importRuns: createGoatElectricCollection<GoatBrainImportRunRow>({
      id: `goat:brain_import_runs:${brainRef}`,
      table: "goat.brain_import_runs",
      params: { brain_ref: brainRef },
      getKey: (row) => row.id,
    }),
  };
}

function createChatMessageCollection(sessionId: string) {
  return createGoatElectricCollection<GoatChatMessageRow>({
    id: `goat:chat_messages:${sessionId}`,
    table: "goat.chat_messages",
    params: { session_id: sessionId },
    getKey: (row) => row.id,
  });
}

const taskRunCollectionsByTaskId = new Map<string, ReturnType<typeof createTaskRunCollections>>();
const chatMessageCollectionsBySessionId = new Map<
  string,
  ReturnType<typeof createChatMessageCollection>
>();
const brainCollectionsByBrainRef = new Map<string, ReturnType<typeof createBrainCollections>>();

function getTaskRunCollections(taskId: string) {
  const cached = taskRunCollectionsByTaskId.get(taskId);
  if (cached) return cached;

  const collections = createTaskRunCollections(taskId);
  taskRunCollectionsByTaskId.set(taskId, collections);
  return collections;
}

function getBrainCollections(brainRef: string) {
  const cached = brainCollectionsByBrainRef.get(brainRef);
  if (cached) return cached;

  const collections = createBrainCollections(brainRef);
  brainCollectionsByBrainRef.set(brainRef, collections);
  return collections;
}

function getChatMessageCollection(sessionId: string) {
  const cached = chatMessageCollectionsBySessionId.get(sessionId);
  if (cached) return cached;

  const collection = createChatMessageCollection(sessionId);
  chatMessageCollectionsBySessionId.set(sessionId, collection);
  return collection;
}

function buildGoatCollections() {
  const tasks = createGoatElectricCollection<GoatTaskRow>({
    id: "goat:tasks",
    table: "goat.tasks",
    getKey: (row) => row.id,
  });

  const taskSchedules = createGoatElectricCollection<GoatTaskScheduleRow>({
    id: "goat:task_schedules",
    table: "goat.task_schedules",
    getKey: (row) => row.id,
  });

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

  // User-scoped (not per-brain): jobs join to these by source_item_id.
  const brainSourceItems = createGoatElectricCollection<GoatBrainSourceItemRow>({
    id: "goat:brain_source_items",
    table: "goat.brain_source_items",
    getKey: (row) => row.id,
  });

  const pendingBrainCaptureSourceItems = createGoatElectricCollection<GoatBrainSourceItemRow>({
    id: "goat:brain_source_items:goat-chat:capture:pending-failed",
    table: "goat.brain_source_items",
    params: {
      source_provider: "goat-chat",
      source_type: "capture",
      last_ingest_status: "pending,failed",
    },
    getKey: (row) => row.id,
  });

  return {
    tasks,
    taskSchedules,
    chatSessions,
    taskRunCollections: getTaskRunCollections,
    chatMessages: getChatMessageCollection,
    codexChatSessions,
    integrations,
    brainCollections: getBrainCollections,
    brainSourceItems,
    pendingBrainCaptureSourceItems,
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
