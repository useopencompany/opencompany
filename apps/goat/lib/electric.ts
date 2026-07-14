type ShapeWhere = {
  clause: string;
  params: string[];
};

type ShapeWhereContext = {
  authorizedChatSessionId?: string | null | undefined;
  authorizedBrainRef?: string | null | undefined;
  workspaceId?: string | null | undefined;
};

const BRAIN_SHAPE_TABLES = new Set([
  "brain_folders",
  "goat.brain_folders",
  "brain_documents",
  "goat.brain_documents",
  "brain_timeline_entries",
  "goat.brain_timeline_entries",
  "brain_edges",
  "goat.brain_edges",
  "brain_ingest_jobs",
  "goat.brain_ingest_jobs",
  "brain_import_runs",
  "goat.brain_import_runs",
]);

// Source items carry full raw/normalized payloads (whole meeting transcripts);
// the activity feed only needs the descriptive columns.
const BRAIN_SOURCE_ITEM_COLUMNS = [
  "id",
  "user_workos_id",
  "source_provider",
  "source_type",
  "external_id",
  "title",
  "occurred_at",
  "captured_at",
  "content_hash",
  "last_ingest_job_id",
  "last_ingest_status",
  "last_ingest_error",
  "last_ingested_at",
  "created_at",
  "updated_at",
] as const;

// Documents sync everything except asset_extracted_text: binary-backed rows
// can carry up to 200KB of machine-extracted text that only search and the
// ingestion agent need, never the UI.
const BRAIN_DOCUMENT_COLUMNS = [
  "id",
  "user_workos_id",
  "created_by_workos_id",
  "brain_ref",
  "brain_id",
  "folder_path",
  "title",
  "content",
  "body",
  "timeline",
  "format",
  "mime_type",
  "original_file_name",
  "asset_storage_key",
  "asset_size_bytes",
  "relations",
  "sources",
  "kind",
  "entity_type",
  "status",
  "aliases",
  "content_hash",
  "size_bytes",
  "created_at",
  "updated_at",
] as const;

// Chat messages sync everything except attachment_texts: docx/xlsx extracted
// text (up to 64KB per attachment) only the chat model needs, never the UI.
const CHAT_MESSAGE_COLUMNS = [
  "id",
  "session_id",
  "role",
  "content",
  "task_id",
  "debug_trace",
  "attachments",
  "created_at",
  "updated_at",
] as const;

const ELECTRIC_CURSOR_PARAMS = ["offset", "handle", "live", "cursor", "replica"] as const;

const SHAPE_SCOPES = {
  tasks: {
    table: "goat.tasks",
    where: scopedUserWhere,
  },
  "goat.tasks": {
    table: "goat.tasks",
    where: scopedUserWhere,
  },
  task_schedules: {
    table: "goat.task_schedules",
    where: scopedUserWhere,
  },
  "goat.task_schedules": {
    table: "goat.task_schedules",
    where: scopedUserWhere,
  },
  task_messages: {
    table: "goat.task_messages",
    where: scopedTaskWhere,
  },
  "goat.task_messages": {
    table: "goat.task_messages",
    where: scopedTaskWhere,
  },
  task_events: {
    table: "goat.task_events",
    where: scopedTaskWhere,
  },
  "goat.task_events": {
    table: "goat.task_events",
    where: scopedTaskWhere,
  },
  task_model_usage: {
    table: "goat.task_model_usage",
    where: scopedTaskWhere,
  },
  "goat.task_model_usage": {
    table: "goat.task_model_usage",
    where: scopedTaskWhere,
  },
  task_tool_usage: {
    table: "goat.task_tool_usage",
    where: scopedTaskWhere,
  },
  "goat.task_tool_usage": {
    table: "goat.task_tool_usage",
    where: scopedTaskWhere,
  },
  task_sandbox_usage: {
    table: "goat.task_sandbox_usage",
    where: scopedTaskWhere,
  },
  "goat.task_sandbox_usage": {
    table: "goat.task_sandbox_usage",
    where: scopedTaskWhere,
  },
  chat_messages: {
    table: "goat.chat_messages",
    where: scopedChatMessageWhere,
    columns: CHAT_MESSAGE_COLUMNS,
  },
  "goat.chat_messages": {
    table: "goat.chat_messages",
    where: scopedChatMessageWhere,
    columns: CHAT_MESSAGE_COLUMNS,
  },
  chat_sessions: {
    table: "goat.chat_sessions",
    where: scopedOpenChatSessionWhere,
  },
  "goat.chat_sessions": {
    table: "goat.chat_sessions",
    where: scopedOpenChatSessionWhere,
  },
  local_codex_sessions: {
    table: "goat.local_codex_sessions",
    where: scopedLocalCodexSessionWhere,
  },
  "goat.local_codex_sessions": {
    table: "goat.local_codex_sessions",
    where: scopedLocalCodexSessionWhere,
  },
  codex_chat_sessions: {
    table: "goat.codex_chat_sessions",
    where: scopedCodexChatSessionWhere,
  },
  "goat.codex_chat_sessions": {
    table: "goat.codex_chat_sessions",
    where: scopedCodexChatSessionWhere,
  },
  integrations: {
    table: "goat.integrations",
    where: scopedIntegrationsWhere,
  },
  "goat.integrations": {
    table: "goat.integrations",
    where: scopedIntegrationsWhere,
  },
  brain_folders: {
    table: "goat.brain_folders",
    where: scopedBrainWhere,
  },
  "goat.brain_folders": {
    table: "goat.brain_folders",
    where: scopedBrainWhere,
  },
  brain_documents: {
    table: "goat.brain_documents",
    where: scopedBrainWhere,
    columns: BRAIN_DOCUMENT_COLUMNS,
  },
  "goat.brain_documents": {
    table: "goat.brain_documents",
    where: scopedBrainWhere,
    columns: BRAIN_DOCUMENT_COLUMNS,
  },
  brain_timeline_entries: {
    table: "goat.brain_timeline_entries",
    where: scopedBrainWhere,
  },
  "goat.brain_timeline_entries": {
    table: "goat.brain_timeline_entries",
    where: scopedBrainWhere,
  },
  brain_edges: {
    table: "goat.brain_edges",
    where: scopedBrainWhere,
  },
  "goat.brain_edges": {
    table: "goat.brain_edges",
    where: scopedBrainWhere,
  },
  brain_ingest_jobs: {
    table: "goat.brain_ingest_jobs",
    where: scopedBrainWhere,
  },
  "goat.brain_ingest_jobs": {
    table: "goat.brain_ingest_jobs",
    where: scopedBrainWhere,
  },
  brain_import_runs: {
    table: "goat.brain_import_runs",
    where: scopedBrainWhere,
  },
  "goat.brain_import_runs": {
    table: "goat.brain_import_runs",
    where: scopedBrainWhere,
  },
  brain_source_items: {
    table: "goat.brain_source_items",
    where: scopedBrainSourceItemWhere,
    columns: BRAIN_SOURCE_ITEM_COLUMNS,
  },
  "goat.brain_source_items": {
    table: "goat.brain_source_items",
    where: scopedBrainSourceItemWhere,
    columns: BRAIN_SOURCE_ITEM_COLUMNS,
  },
} as const;

export function goatElectricBaseUrl() {
  return process.env.ELECTRIC_URL?.replace(/\/+$/, "") ?? null;
}

export function hasInvalidElectricCloudSecretPair(input: {
  sourceId?: string | null | undefined;
  sourceSecret?: string | null | undefined;
}) {
  return Boolean(input.sourceId) !== Boolean(input.sourceSecret);
}

export function buildGoatElectricOriginUrl(input: {
  electricUrl: string;
  requestUrl: URL;
  userWorkosId: string;
  workspaceId?: string | null | undefined;
  authorizedChatSessionId?: string | null | undefined;
  authorizedBrainRef?: string | null | undefined;
  sourceId?: string | null | undefined;
  sourceSecret?: string | null | undefined;
  electricSecret?: string | null | undefined;
}) {
  const requestedTable = input.requestUrl.searchParams.get("table");
  const scope: {
    table: string;
    where: (userWorkosId: string, requestUrl: URL, context: ShapeWhereContext) => ShapeWhere | null;
    columns?: readonly string[];
  } | null = requestedTable
    ? (SHAPE_SCOPES[requestedTable as keyof typeof SHAPE_SCOPES] ?? null)
    : null;
  if (!scope) return null;

  const originUrl = new URL(`${input.electricUrl.replace(/\/+$/, "")}/v1/shape`);
  for (const key of ELECTRIC_CURSOR_PARAMS) {
    const value = input.requestUrl.searchParams.get(key);
    if (value !== null) originUrl.searchParams.set(key, value);
  }

  const resolved = scope.where(input.userWorkosId, input.requestUrl, {
    authorizedChatSessionId: input.authorizedChatSessionId,
    authorizedBrainRef: input.authorizedBrainRef,
    workspaceId: input.workspaceId,
  });
  if (!resolved) return null;

  originUrl.searchParams.set("table", scope.table);
  if (scope.columns) originUrl.searchParams.set("columns", scope.columns.join(","));
  originUrl.searchParams.set("where", resolved.clause);
  resolved.params.forEach((param, index) => {
    originUrl.searchParams.set(`params[${index + 1}]`, param);
  });

  if (input.sourceId && input.sourceSecret) {
    originUrl.searchParams.set("source_id", input.sourceId);
    originUrl.searchParams.set("secret", input.sourceSecret);
  } else if (input.electricSecret) {
    originUrl.searchParams.set("secret", input.electricSecret);
  }

  return originUrl;
}

function scopedTaskWhere(userWorkosId: string, requestUrl: URL): ShapeWhere {
  const taskId = requestUrl.searchParams.get("task_id")?.trim();
  if (!taskId) {
    return {
      clause: `"user_workos_id" = $1`,
      params: [userWorkosId],
    };
  }
  return {
    clause: `"user_workos_id" = $1 AND "task_id" = $2`,
    params: [userWorkosId, taskId],
  };
}

export function goatElectricChatMessagesSessionId(requestUrl: URL) {
  const table = requestUrl.searchParams.get("table");
  if (table !== "chat_messages" && table !== "goat.chat_messages") return null;

  const sessionId = requestUrl.searchParams.get("session_id")?.trim();
  return sessionId || null;
}

export function goatElectricLocalCodexChatSessionId(requestUrl: URL) {
  const table = requestUrl.searchParams.get("table");
  if (table !== "local_codex_sessions" && table !== "goat.local_codex_sessions") return null;

  const sessionId = requestUrl.searchParams.get("chat_session_id")?.trim();
  return sessionId || null;
}

function scopedChatMessageWhere(
  _userWorkosId: string,
  requestUrl: URL,
  context: ShapeWhereContext,
): ShapeWhere | null {
  const sessionId = goatElectricChatMessagesSessionId(requestUrl);
  if (!sessionId || context.authorizedChatSessionId !== sessionId) return null;

  return {
    clause: `"session_id" = $1`,
    params: [sessionId],
  };
}

function scopedLocalCodexSessionWhere(
  _userWorkosId: string,
  requestUrl: URL,
  context: ShapeWhereContext,
): ShapeWhere | null {
  const sessionId = goatElectricLocalCodexChatSessionId(requestUrl);
  if (!sessionId || context.authorizedChatSessionId !== sessionId) return null;

  return {
    clause: `"chat_session_id" = $1`,
    params: [sessionId],
  };
}

export function goatElectricCodexChatSessionId(requestUrl: URL) {
  const table = requestUrl.searchParams.get("table");
  if (table !== "codex_chat_sessions" && table !== "goat.codex_chat_sessions") return null;

  const sessionId = requestUrl.searchParams.get("chat_session_id")?.trim();
  return sessionId || null;
}

function scopedCodexChatSessionWhere(
  _userWorkosId: string,
  requestUrl: URL,
  context: ShapeWhereContext,
): ShapeWhere | null {
  const sessionId = goatElectricCodexChatSessionId(requestUrl);
  if (!sessionId || context.authorizedChatSessionId !== sessionId) return null;

  return {
    clause: `"chat_session_id" = $1`,
    params: [sessionId],
  };
}

export function goatElectricBrainRef(requestUrl: URL) {
  const table = requestUrl.searchParams.get("table");
  if (!table || !BRAIN_SHAPE_TABLES.has(table)) return null;

  const brainRef = requestUrl.searchParams.get("brain_ref")?.trim();
  return brainRef || null;
}

// Brain shapes are only forwarded when the route authorized the requested
// brain_ref for this user; the client-supplied value is never trusted here.
function scopedBrainWhere(
  _userWorkosId: string,
  requestUrl: URL,
  context: ShapeWhereContext,
): ShapeWhere | null {
  const brainRef = goatElectricBrainRef(requestUrl);
  if (!brainRef || context.authorizedBrainRef !== brainRef) return null;

  return {
    clause: `"brain_ref" = $1`,
    params: [brainRef],
  };
}

function scopedOpenChatSessionWhere(userWorkosId: string): ShapeWhere {
  return {
    clause: `"user_workos_id" = $1 AND "closed_at" IS NULL`,
    params: [userWorkosId],
  };
}

function scopedBrainSourceItemWhere(userWorkosId: string, requestUrl: URL): ShapeWhere | null {
  const params = [userWorkosId];
  const clauses = [`"user_workos_id" = $1`];

  const sourceProvider = optionalEnumFilter(requestUrl, "source_provider", [
    "goat-chat",
    "jamie",
    "upload",
  ]);
  if (sourceProvider === false) return null;
  if (sourceProvider) {
    params.push(sourceProvider);
    clauses.push(`"source_provider" = $${params.length}`);
  }

  const sourceType = optionalEnumFilter(requestUrl, "source_type", ["capture", "meeting", "asset"]);
  if (sourceType === false) return null;
  if (sourceType) {
    params.push(sourceType);
    clauses.push(`"source_type" = $${params.length}`);
  }

  const ingestStatuses = optionalEnumListFilter(requestUrl, "last_ingest_status", [
    "pending",
    "succeeded",
    "failed",
    "skipped",
  ]);
  if (ingestStatuses === false) return null;
  if (ingestStatuses.length === 1) {
    params.push(ingestStatuses[0]!);
    clauses.push(`"last_ingest_status" = $${params.length}`);
  } else if (ingestStatuses.length > 1) {
    const placeholders = ingestStatuses.map((status) => {
      params.push(status);
      return `$${params.length}`;
    });
    clauses.push(`"last_ingest_status" IN (${placeholders.join(", ")})`);
  }

  return {
    clause: clauses.join(" AND "),
    params,
  };
}

function scopedUserWhere(userWorkosId: string): ShapeWhere {
  return {
    clause: `"user_workos_id" = $1`,
    params: [userWorkosId],
  };
}

// Integrations are visible when personally owned OR owned by the active
// workspace (github/jamie plumbing every member can see the status of).
function scopedIntegrationsWhere(
  userWorkosId: string,
  _requestUrl: URL,
  context: ShapeWhereContext,
): ShapeWhere {
  if (!context.workspaceId) {
    return {
      clause: `"user_workos_id" = $1 AND "workspace_id" IS NULL`,
      params: [userWorkosId],
    };
  }
  return {
    clause: `("user_workos_id" = $1 AND "workspace_id" IS NULL) OR "workspace_id" = $2`,
    params: [userWorkosId, context.workspaceId],
  };
}

function optionalEnumFilter<T extends string>(
  requestUrl: URL,
  key: string,
  allowed: readonly T[],
): T | false | null {
  const value = requestUrl.searchParams.get(key)?.trim();
  if (!value) return null;
  return allowed.includes(value as T) ? (value as T) : false;
}

function optionalEnumListFilter<T extends string>(
  requestUrl: URL,
  key: string,
  allowed: readonly T[],
): T[] | false {
  const value = requestUrl.searchParams.get(key)?.trim();
  if (!value) return [];
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length === 0) return [];
  if (values.some((item) => !allowed.includes(item as T))) return false;
  return Array.from(new Set(values as T[]));
}
