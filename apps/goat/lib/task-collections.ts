import type {
  GoatBrainFolderSource,
  GoatBrainImportDiscoverySummary,
  GoatBrainImportSourceSelection,
  GoatBrainImportStatus,
  GoatChatMessageAttachment,
  GoatHarnessEngine,
  GoatIntegrationProvider,
  GoatIntegrationStatus,
  GoatTaskCommentAuthor,
  GoatTaskCommentKind,
  GoatTaskCommentMetadata,
  GoatTaskStatus,
} from "@opencompany/db/goat-schema";
import { createGoatElectricCollection } from "@/lib/electric-collection";

export type GoatTaskRow = {
  id: string;
  display_id: string;
  name: string;
  user_workos_id: string;
  prompt: string;
  model: string;
  schedule_id: string | null;
  scheduled_for: string | null;
  engine: GoatHarnessEngine;
  status: GoatTaskStatus;
  result: string | null;
  error: string | null;
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
  model: string | null;
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
  engine: "opencompany" | "local_codex" | "codex";
  closed_at: string | null;
  pinned_at: string | null;
  created_at: string;
  updated_at: string;
};

export type GoatLocalCodexSessionRow = {
  id: string;
  user_workos_id: string;
  chat_session_id: string;
  bridge_id: string | null;
  repository_path: string | null;
  worktree_path: string | null;
  model: string;
  codex_thread_id: string | null;
  active_turn_id: string | null;
  status: "starting" | "idle" | "running" | "failed" | "interrupted" | "closed";
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type GoatCodexChatSessionRow = {
  id: string;
  user_workos_id: string;
  chat_session_id: string;
  model: string;
  sandbox_id: string | null;
  codex_thread_id: string | null;
  active_turn_id: string | null;
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

export type GoatTaskCommentRow = {
  id: string;
  task_id: string;
  user_workos_id: string;
  author: GoatTaskCommentAuthor;
  kind: GoatTaskCommentKind;
  content: string;
  metadata: GoatTaskCommentMetadata;
  created_at: string;
  updated_at: string;
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

function createTaskCommentCollection(taskId: string) {
  return createGoatElectricCollection<GoatTaskCommentRow>({
    id: `goat:task_comments:${taskId}`,
    table: "goat.task_comments",
    params: { task_id: taskId },
    getKey: (row) => row.id,
  });
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

function createLocalCodexSessionCollection(chatSessionId: string) {
  return createGoatElectricCollection<GoatLocalCodexSessionRow>({
    id: `goat:local_codex_sessions:${chatSessionId}`,
    table: "goat.local_codex_sessions",
    params: { chat_session_id: chatSessionId },
    getKey: (row) => row.id,
  });
}

const taskCommentCollectionsByTaskId = new Map<
  string,
  ReturnType<typeof createTaskCommentCollection>
>();
const chatMessageCollectionsBySessionId = new Map<
  string,
  ReturnType<typeof createChatMessageCollection>
>();
const localCodexSessionCollectionsByChatSessionId = new Map<
  string,
  ReturnType<typeof createLocalCodexSessionCollection>
>();
const brainCollectionsByBrainRef = new Map<string, ReturnType<typeof createBrainCollections>>();

function getTaskCommentCollection(taskId: string) {
  const cached = taskCommentCollectionsByTaskId.get(taskId);
  if (cached) return cached;

  const collection = createTaskCommentCollection(taskId);
  taskCommentCollectionsByTaskId.set(taskId, collection);
  return collection;
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

function getLocalCodexSessionCollection(chatSessionId: string) {
  const cached = localCodexSessionCollectionsByChatSessionId.get(chatSessionId);
  if (cached) return cached;

  const collection = createLocalCodexSessionCollection(chatSessionId);
  localCodexSessionCollectionsByChatSessionId.set(chatSessionId, collection);
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
    taskComments: getTaskCommentCollection,
    chatMessages: getChatMessageCollection,
    localCodexSessions: getLocalCodexSessionCollection,
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
