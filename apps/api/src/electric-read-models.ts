import type { Actor } from "@opencompany/core";
import { normalizeGoatBrainIngestTrace } from "@opencompany/db/goat-brain-ingest-trace";
import {
  BrainDocumentReadModelSchema,
  BrainEdgeReadModelSchema,
  BrainFolderReadModelSchema,
  BrainIngestJobReadModelSchema,
  BrainTimelineReadModelSchema,
  ConversationReadModelSchema,
  MessageReadModelSchema,
  type ReadModel,
  RunReadModelSchema,
  TaskOutcomeSchema,
  TaskReadModelSchema,
  TaskScheduleReadModelSchema,
  WikiPageReadModelSchema,
  WikiTimelineReadModelSchema,
  WorkflowReadModelSchema,
  WorkflowScheduleReadModelSchema,
} from "@opencompany/protocol";
import { ApiError } from "./errors";

// Safe client-managed ShapeStream state from @electric-sql/client. Shape identity (table,
// columns, where, and bound params) remains server-owned below.
const ELECTRIC_CURSOR_PARAMS = [
  "offset",
  "handle",
  "live",
  "cursor",
  "log",
  "expired_handle",
  "cache-buster",
] as const;

// Only Shape protocol metadata belongs on the reconstructed API response. In particular,
// hop-by-hop headers such as Connection and Transfer-Encoding describe Electric's socket. If
// they are copied here, the Node adapter can combine the upstream Transfer-Encoding with a new
// Content-Length, producing an invalid response that the public edge rejects with a 502.
const ELECTRIC_RESPONSE_HEADERS = [
  "electric-cursor",
  "electric-handle",
  "electric-offset",
  "electric-schema",
  "electric-up-to-date",
] as const;

// These columns cross the API boundary as decoded JSON values. Omitting their upstream JSONB
// metadata prevents @electric-sql/client from parsing the already-decoded values a second time.
const PREDECODED_READ_MODEL_FIELDS = new Set([
  "presentation",
  "attachments",
  "steps",
  "trigger",
  "timeline",
  "relations",
  "result",
  "sources",
  "aliases",
]);

export interface ReadModelService {
  stream(input: {
    actor: Actor;
    readModel: ReadModel;
    conversationId?: string;
    brainId?: string;
    requestUrl: URL;
  }): Promise<Response>;
}

type ElectricReadModelProxyOptions = {
  electricUrl: string;
  sourceId?: string;
  sourceSecret?: string;
  electricSecret?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
};

export class ElectricReadModelProxy implements ReadModelService {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: ElectricReadModelProxyOptions) {
    if (Boolean(options.sourceId) !== Boolean(options.sourceSecret)) {
      throw new Error("Electric source credentials must be configured together.");
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async stream(input: {
    actor: Actor;
    readModel: ReadModel;
    conversationId?: string;
    brainId?: string;
    requestUrl: URL;
  }) {
    const shape = readModelShape(input);
    const origin = new URL("/v1/shape", `${this.options.electricUrl.trim().replace(/\/+$/u, "")}/`);
    for (const parameter of ELECTRIC_CURSOR_PARAMS) {
      const value = input.requestUrl.searchParams.get(parameter);
      if (value !== null) origin.searchParams.set(parameter, value);
    }
    origin.searchParams.set("table", shape.table);
    origin.searchParams.set("columns", shape.columns.join(","));
    origin.searchParams.set("where", shape.where);
    // Full replica messages include physical old_value fields. Canonical clients use the current
    // projection only, so replica mode is fixed on the server.
    origin.searchParams.set("replica", "default");
    shape.params.forEach((value, index) => origin.searchParams.set(`params[${index + 1}]`, value));

    const usesQuerySecret = Boolean(
      (this.options.sourceId && this.options.sourceSecret) || this.options.electricSecret,
    );
    if (this.options.sourceId && this.options.sourceSecret) {
      origin.searchParams.set("source_id", this.options.sourceId);
      origin.searchParams.set("secret", this.options.sourceSecret);
    } else if (this.options.electricSecret) {
      origin.searchParams.set("secret", this.options.electricSecret);
    }

    const upstream = await this.fetchImpl(origin, {
      headers:
        !usesQuerySecret && this.options.token
          ? { Authorization: `Bearer ${this.options.token}` }
          : {},
    });
    if (!upstream.ok) {
      if (upstream.status === 409) return electricRecoveryResponse(upstream, input.readModel);
      // Never proxy provider error bodies: Electric may include the requested URL, physical
      // shape, or query credentials in diagnostics. The API error middleware supplies the
      // canonical public envelope and request id instead.
      throw new ApiError(502, "unavailable", "Electric read models are unavailable.", true);
    }
    // Electric may use 204 for a successful long poll with no changes. The client state machine
    // consumes its cursor/handle headers and intentionally does not parse a response body.
    if (upstream.status === 204) return electricNoContentResponse(upstream, input.readModel);
    if (!upstream.body) {
      throw new ApiError(502, "unavailable", "Electric returned an empty read model.", true);
    }

    let payload: unknown;
    try {
      payload = await upstream.json();
    } catch {
      throw new ApiError(502, "unavailable", "Electric returned an invalid read model.", true);
    }
    if (!Array.isArray(payload)) {
      throw new ApiError(502, "unavailable", "Electric returned an invalid read model.", true);
    }
    const projected = payload.map((entry) => projectElectricEntry(input.readModel, entry));
    const headers = safeElectricHeaders(upstream.headers, input.readModel);
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "private, no-store");
    headers.set("Vary", "Authorization, Cookie");
    return Response.json(projected, { status: upstream.status, headers });
  }
}

function readModelShape(input: {
  actor: Actor;
  readModel: ReadModel;
  conversationId?: string;
  brainId?: string;
}) {
  switch (input.readModel) {
    case "chat-conversations-v1":
      return {
        table: "goat.conversation_read_model_v1",
        columns: [
          "id",
          "title",
          "engine",
          "model",
          "archived_at",
          "pinned_at",
          "last_seen_at",
          "created_at",
          "updated_at",
        ],
        where: `"actor_id" = $1 AND ("workspace_id" = $2 OR "workspace_id" IS NULL)`,
        params: [input.actor.userId, input.actor.workspaceId],
      };
    case "chat-messages-v1":
      return conversationShape(input, "goat.message_read_model_v1", [
        "id",
        "conversation_id",
        "role",
        "content",
        "task_id",
        "presentation",
        "attachments",
        "created_at",
        "updated_at",
      ]);
    case "chat-runs-v1":
      return conversationShape(input, "goat.run_read_model_v1", [
        "id",
        "conversation_id",
        "trigger_message_id",
        "assistant_message_id",
        "status",
        "engine",
        "model",
        "attempt_count",
        "error",
        "created_at",
        "updated_at",
      ]);
    case "tasks-v1":
      return {
        table: "goat.task_read_model_v1",
        columns: [
          "id",
          "display_id",
          "name",
          "goal",
          "conversation_id",
          "status",
          "source",
          "engine",
          "model",
          "workflow_id",
          "schedule_id",
          "scheduled_for",
          "result",
          "error",
          "reported_status",
          "outcome_comment",
          "archived_at",
          "created_at",
          "updated_at",
        ],
        where: `("workspace_id" = $2 OR (` + `"workspace_id" IS NULL AND "actor_id" = $1))`,
        params: [input.actor.userId, input.actor.workspaceId],
      };
    case "workflows-v1":
      return {
        table: "goat.workflow_read_model_v1",
        columns: [
          "id",
          "slug",
          "name",
          "description",
          "steps",
          "status",
          "trigger",
          "version",
          "archived_at",
          "created_at",
          "updated_at",
        ],
        where: `"workspace_id" = $1`,
        params: [input.actor.workspaceId],
      };
    case "workflow-schedules-v1":
      return {
        table: "goat.workflow_schedule_read_model_v1",
        columns: [
          "id",
          "workflow_id",
          "workflow_slug",
          "name",
          "cron",
          "timezone",
          "prompt",
          "enabled",
          "last_run_at",
          "next_run_at",
          "version",
          "created_at",
          "updated_at",
        ],
        where: `"workspace_id" = $1`,
        params: [input.actor.workspaceId],
      };
    case "task-schedules-v1":
      return {
        table: "goat.task_schedule_read_model_v1",
        columns: [
          "id",
          "name",
          "source_description",
          "cron",
          "timezone",
          "prompt",
          "enabled",
          "last_run_at",
          "next_run_at",
          "version",
          "created_at",
          "updated_at",
        ],
        where: `"actor_id" = $1 AND ("workspace_id" = $2 OR "workspace_id" IS NULL)`,
        params: [input.actor.userId, input.actor.workspaceId],
      };
    case "brain-folders-v1":
      return brainShape(input, "goat.brain_folders", [
        "id",
        "path",
        "source",
        "created_at",
        "updated_at",
      ]);
    case "brain-documents-v1":
      return brainShape(input, "goat.brain_documents", [
        "id",
        "brain_id",
        "folder_path",
        "title",
        "content",
        "body",
        "timeline",
        "format",
        "mime_type",
        "original_file_name",
        "asset_size_bytes",
        "relations",
        "sources",
        "kind",
        "entity_type",
        "status",
        "aliases",
        "content_hash",
        "size_bytes",
        "created_by_workos_id",
        "created_at",
        "updated_at",
      ]);
    case "brain-timeline-v1":
      return brainShape(input, "goat.brain_timeline_entries", [
        "id",
        "document_id",
        "brain_id",
        "evidence_id",
        "at",
        "source_ref",
        "source_title",
        "summary",
        "detail",
        "created_at",
      ]);
    case "brain-edges-v1":
      return brainShape(input, "goat.brain_edges", [
        "id",
        "document_id",
        "from_brain_id",
        "to_brain_id",
        "relation_type",
        "source_kind",
        "created_at",
        "updated_at",
      ]);
    case "brain-ingest-jobs-v1":
      return brainShape(input, "goat.brain_ingest_jobs", [
        "id",
        "source_item_id",
        "source_provider",
        "kind",
        "status",
        "plan_paused",
        "attempts",
        "last_error",
        "result",
        "completed_at",
        "created_at",
        "updated_at",
      ]);
    case "wiki-pages-v1":
      return {
        table: "goat.wiki_pages",
        columns: [
          "id",
          "slug",
          "path",
          "title",
          "kind",
          "content",
          "content_hash",
          "size_bytes",
          "format",
          "mime_type",
          "original_file_name",
          "asset_size_bytes",
          "created_at",
          "updated_at",
        ],
        where: `"workspace_id" = $1`,
        params: [input.actor.workspaceId],
      };
    case "wiki-timeline-v1":
      return {
        table: "goat.wiki_timeline_entries",
        columns: ["id", "page_id", "at", "text", "created_at"],
        where: `"workspace_id" = $1`,
        params: [input.actor.workspaceId],
      };
    default:
      throw new ApiError(400, "invalid_request", "Unknown read model.");
  }
}

function brainShape(input: { brainId?: string }, table: string, columns: string[]) {
  if (!input.brainId) {
    throw new ApiError(400, "invalid_request", "brainId is required for this read model.");
  }
  return { table, columns, where: `"brain_ref" = $1`, params: [input.brainId] };
}

function conversationShape(
  input: { actor: Actor; conversationId?: string },
  table: string,
  columns: string[],
) {
  if (!input.conversationId) {
    throw new ApiError(400, "invalid_request", "conversationId is required for this read model.");
  }
  return {
    table,
    columns,
    where:
      `"conversation_id" = $1 ` +
      `AND ("workspace_id" = $3 OR ("workspace_id" IS NULL AND "actor_id" = $2))`,
    params: [input.conversationId, input.actor.userId, input.actor.workspaceId],
  };
}

function projectElectricEntry(readModel: ReadModel, entry: unknown) {
  if (!isRecord(entry) || !isRecord(entry.value)) return entry;
  const operation = isRecord(entry.headers) ? entry.headers.operation : undefined;
  return {
    key: entry.key,
    headers: entry.headers,
    value: projectReadModelValue(readModel, entry.value, operation !== "insert"),
  };
}

function projectReadModelValue(
  readModel: ReadModel,
  row: Record<string, unknown>,
  partial: boolean,
) {
  const columnNames = READ_MODEL_COLUMN_NAMES[
    readModel as keyof typeof READ_MODEL_COLUMN_NAMES
  ] as Record<string, string>;
  const projected: Record<string, unknown> = Object.fromEntries(
    Object.entries(columnNames).flatMap(([physicalName, publicName]) =>
      publicName && Object.hasOwn(row, physicalName)
        ? [[publicName, readModelFieldValue(readModel, publicName, row[physicalName])]]
        : [],
    ),
  );
  if (readModel === "brain-documents-v1") {
    if (typeof projected.folderPath === "string" && typeof projected.brainId === "string") {
      projected.path = `${projected.folderPath}/${projected.brainId}.md`;
    }
    if (projected.title === null && typeof projected.brainId === "string") {
      projected.title = projected.brainId;
    }
  }
  if (readModel === "tasks-v1") {
    const outcome = Object.fromEntries(
      Object.entries(TASK_OUTCOME_COLUMN_NAMES).flatMap(([physicalName, publicName]) =>
        Object.hasOwn(row, physicalName) ? [[publicName, row[physicalName]]] : [],
      ),
    );
    if (Object.keys(outcome).length > 0) projected.outcome = outcome;
    const schema = partial
      ? TaskReadModelSchema.partial().extend({ outcome: TaskOutcomeSchema.partial().optional() })
      : TaskReadModelSchema;
    return schema.parse(projected);
  }
  if (readModel === "workflows-v1") {
    const schema = partial ? WorkflowReadModelSchema.partial() : WorkflowReadModelSchema;
    return schema.parse(projected);
  }
  if (readModel === "brain-ingest-jobs-v1" && Object.hasOwn(projected, "result")) {
    projected.result = publicBrainIngestJobResult(projected.result);
  }
  if (readModel === "brain-ingest-jobs-v1" && Object.hasOwn(projected, "lastError")) {
    projected.lastError = boundedNullableString(projected.lastError, 2_000);
  }
  switch (readModel) {
    case "chat-conversations-v1":
      return (partial ? ConversationReadModelSchema.partial() : ConversationReadModelSchema).parse(
        projected,
      );
    case "chat-messages-v1":
      return (partial ? MessageReadModelSchema.partial() : MessageReadModelSchema).parse(projected);
    case "chat-runs-v1":
      return (partial ? RunReadModelSchema.partial() : RunReadModelSchema).parse(projected);
    case "workflow-schedules-v1":
      return (
        partial ? WorkflowScheduleReadModelSchema.partial() : WorkflowScheduleReadModelSchema
      ).parse(projected);
    case "task-schedules-v1":
      return (partial ? TaskScheduleReadModelSchema.partial() : TaskScheduleReadModelSchema).parse(
        projected,
      );
    case "brain-folders-v1":
      return (partial ? BrainFolderReadModelSchema.partial() : BrainFolderReadModelSchema).parse(
        projected,
      );
    case "brain-documents-v1":
      return (
        partial ? BrainDocumentReadModelSchema.partial() : BrainDocumentReadModelSchema
      ).parse(projected);
    case "brain-timeline-v1":
      return (
        partial ? BrainTimelineReadModelSchema.partial() : BrainTimelineReadModelSchema
      ).parse(projected);
    case "brain-edges-v1":
      return (partial ? BrainEdgeReadModelSchema.partial() : BrainEdgeReadModelSchema).parse(
        projected,
      );
    case "brain-ingest-jobs-v1":
      return (
        partial ? BrainIngestJobReadModelSchema.partial() : BrainIngestJobReadModelSchema
      ).parse(projected);
    case "wiki-pages-v1":
      return (partial ? WikiPageReadModelSchema.partial() : WikiPageReadModelSchema).parse(
        projected,
      );
    case "wiki-timeline-v1":
      return (partial ? WikiTimelineReadModelSchema.partial() : WikiTimelineReadModelSchema).parse(
        projected,
      );
  }
}

function readModelFieldValue(readModel: ReadModel, name: string, value: unknown) {
  if (name.endsWith("At") || name === "at") return timestampValue(value);
  if (
    name === "attemptCount" ||
    name === "version" ||
    name === "attempts" ||
    name === "sizeBytes" ||
    name === "assetSizeBytes" ||
    (readModel === "brain-timeline-v1" && name === "id")
  ) {
    return value === null ? null : numberValue(value);
  }
  if (
    name === "presentation" ||
    name === "steps" ||
    name === "trigger" ||
    name === "timeline" ||
    name === "relations" ||
    name === "sources" ||
    name === "aliases" ||
    name === "result"
  ) {
    return jsonValue(value);
  }
  if (name === "attachments") {
    const attachments = jsonValue(value);
    return Array.isArray(attachments) ? attachments.map(publicAttachment) : attachments;
  }
  return value;
}

function publicAttachment(value: unknown) {
  if (!isRecord(value)) return value;
  return {
    id: value.id,
    filename: value.filename,
    mediaType: value.mediaType,
    sizeBytes: numberValue(value.sizeBytes),
    kind: value.kind,
  };
}

function publicBrainIngestJobResult(value: unknown) {
  const result = jsonValue(value);
  if (!isRecord(result)) return {};

  const pages = Array.isArray(result.pages)
    ? result.pages.slice(0, 20).flatMap((page) => {
        if (!isRecord(page)) return [];
        const brainId = limitedString(page.brainId, 80);
        const folderPath = limitedString(page.folderPath, 512);
        const title = limitedString(page.title, 160);
        const action = page.action;
        if (
          !brainId ||
          !folderPath ||
          (action !== "created" && action !== "updated" && action !== "conflict_created")
        ) {
          return [];
        }
        return [{ brainId, folderPath, title, action }];
      })
    : undefined;
  const trace = normalizeGoatBrainIngestTrace(result.trace);
  const durationMs = typeof result.durationMs === "number" ? result.durationMs : null;

  return {
    ...(typeof result.summary === "string" ? { summary: result.summary.slice(0, 2_000) } : {}),
    ...(limitedString(result.draftBrainId, 80)
      ? { draftBrainId: limitedString(result.draftBrainId, 80) }
      : {}),
    ...(limitedString(result.meetingBrainId, 80)
      ? { meetingBrainId: limitedString(result.meetingBrainId, 80) }
      : {}),
    ...(pages ? { pages } : {}),
    ...(typeof result.skipped === "boolean" ? { skipped: result.skipped } : {}),
    ...(durationMs !== null && Number.isFinite(durationMs) && durationMs >= 0
      ? { durationMs }
      : {}),
    ...(trace ? { trace } : {}),
  };
}

function limitedString(value: unknown, limit: number) {
  return typeof value === "string" && value.length <= limit ? value : "";
}

function boundedNullableString(value: unknown, limit: number) {
  if (value === null) return null;
  return typeof value === "string" ? value.slice(0, limit) : value;
}

function numberValue(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : value;
}

function jsonValue(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function timestampValue(value: unknown) {
  if (typeof value !== "string") return value;
  // Electric serializes timestamptz values in PostgreSQL's wire form
  // (`YYYY-MM-DD HH:mm:ss.SSS+00`). Canonical protocol timestamps are ISO 8601.
  const isoCandidate = value.replace(" ", "T").replace(/([+-]\d{2})$/u, "$1:00");
  const timestamp = new Date(isoCandidate);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toISOString();
}

function electricNoContentResponse(upstream: Response, readModel: ReadModel) {
  const headers = safeElectricHeaders(upstream.headers, readModel);
  headers.delete("content-type");
  headers.set("Cache-Control", "private, no-store");
  headers.set("Vary", "Authorization, Cookie");
  return new Response(null, {
    status: 204,
    statusText: upstream.statusText,
    headers,
  });
}

function electricRecoveryResponse(upstream: Response, readModel: ReadModel) {
  const headers = safeElectricHeaders(upstream.headers, readModel);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "private, no-store");
  headers.set("Vary", "Authorization, Cookie");
  return new Response("[]", {
    status: 409,
    statusText: upstream.statusText,
    headers,
  });
}

function safeElectricHeaders(source: Headers, readModel: ReadModel) {
  const headers = new Headers();
  for (const name of ELECTRIC_RESPONSE_HEADERS) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  const schema = headers.get("electric-schema");
  if (schema) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(schema);
    } catch {
      throw new ApiError(
        502,
        "unavailable",
        "Electric returned an invalid read model schema.",
        true,
      );
    }
    if (!isRecord(parsed)) {
      throw new ApiError(
        502,
        "unavailable",
        "Electric returned an invalid read model schema.",
        true,
      );
    }
    const names = READ_MODEL_COLUMN_NAMES[
      readModel as keyof typeof READ_MODEL_COLUMN_NAMES
    ] as Record<string, string>;
    headers.set(
      "electric-schema",
      JSON.stringify(
        Object.fromEntries(
          Object.entries(parsed).flatMap(([name, definition]) =>
            names[name] && !PREDECODED_READ_MODEL_FIELDS.has(names[name])
              ? [[names[name], definition]]
              : [],
          ),
        ),
      ),
    );
  }
  return headers;
}

const READ_MODEL_COLUMN_NAMES = {
  "chat-conversations-v1": {
    id: "id",
    title: "title",
    engine: "engine",
    model: "model",
    archived_at: "archivedAt",
    pinned_at: "pinnedAt",
    last_seen_at: "lastSeenAt",
    created_at: "createdAt",
    updated_at: "updatedAt",
  },
  "chat-messages-v1": {
    id: "id",
    conversation_id: "conversationId",
    role: "role",
    content: "content",
    task_id: "taskId",
    presentation: "presentation",
    attachments: "attachments",
    created_at: "createdAt",
    updated_at: "updatedAt",
  },
  "chat-runs-v1": {
    id: "id",
    conversation_id: "conversationId",
    trigger_message_id: "triggerMessageId",
    assistant_message_id: "assistantMessageId",
    status: "status",
    engine: "engine",
    model: "model",
    attempt_count: "attemptCount",
    error: "error",
    created_at: "createdAt",
    updated_at: "updatedAt",
  },
  "tasks-v1": {
    id: "id",
    display_id: "displayId",
    name: "name",
    goal: "goal",
    conversation_id: "conversationId",
    status: "status",
    source: "source",
    engine: "engine",
    model: "model",
    workflow_id: "workflowId",
    schedule_id: "scheduleId",
    scheduled_for: "scheduledFor",
    result: "",
    error: "",
    reported_status: "",
    outcome_comment: "",
    archived_at: "archivedAt",
    created_at: "createdAt",
    updated_at: "updatedAt",
  },
  "workflows-v1": {
    id: "id",
    slug: "slug",
    name: "name",
    description: "description",
    steps: "steps",
    status: "status",
    trigger: "trigger",
    version: "version",
    archived_at: "archivedAt",
    created_at: "createdAt",
    updated_at: "updatedAt",
  },
  "workflow-schedules-v1": {
    id: "id",
    workflow_id: "workflowId",
    workflow_slug: "workflowSlug",
    name: "name",
    cron: "cron",
    timezone: "timezone",
    prompt: "prompt",
    enabled: "enabled",
    last_run_at: "lastRunAt",
    next_run_at: "nextRunAt",
    version: "version",
    created_at: "createdAt",
    updated_at: "updatedAt",
  },
  "task-schedules-v1": {
    id: "id",
    name: "name",
    source_description: "sourceDescription",
    cron: "cron",
    timezone: "timezone",
    prompt: "prompt",
    enabled: "enabled",
    last_run_at: "lastRunAt",
    next_run_at: "nextRunAt",
    version: "version",
    created_at: "createdAt",
    updated_at: "updatedAt",
  },
  "brain-folders-v1": {
    id: "id",
    path: "path",
    source: "source",
    created_at: "createdAt",
    updated_at: "updatedAt",
  },
  "brain-documents-v1": {
    id: "id",
    brain_id: "brainId",
    folder_path: "folderPath",
    title: "title",
    content: "content",
    body: "body",
    timeline: "timeline",
    format: "format",
    mime_type: "mimeType",
    original_file_name: "originalFileName",
    asset_size_bytes: "assetSizeBytes",
    relations: "relations",
    sources: "sources",
    kind: "kind",
    entity_type: "type",
    status: "status",
    aliases: "aliases",
    content_hash: "contentHash",
    size_bytes: "sizeBytes",
    created_by_workos_id: "createdByActorId",
    created_at: "createdAt",
    updated_at: "updatedAt",
  },
  "brain-timeline-v1": {
    id: "id",
    document_id: "documentId",
    brain_id: "brainId",
    evidence_id: "evidenceId",
    at: "at",
    source_ref: "sourceRef",
    source_title: "sourceTitle",
    summary: "summary",
    detail: "detail",
    created_at: "createdAt",
  },
  "brain-edges-v1": {
    id: "id",
    document_id: "documentId",
    from_brain_id: "fromBrainId",
    to_brain_id: "toBrainId",
    relation_type: "relationType",
    source_kind: "sourceKind",
    created_at: "createdAt",
    updated_at: "updatedAt",
  },
  "brain-ingest-jobs-v1": {
    id: "id",
    source_item_id: "sourceItemId",
    source_provider: "sourceProvider",
    kind: "kind",
    status: "status",
    plan_paused: "planPaused",
    attempts: "attempts",
    last_error: "lastError",
    result: "result",
    completed_at: "completedAt",
    created_at: "createdAt",
    updated_at: "updatedAt",
  },
  "wiki-pages-v1": {
    id: "id",
    slug: "slug",
    path: "path",
    title: "title",
    kind: "kind",
    content: "body",
    content_hash: "contentHash",
    size_bytes: "sizeBytes",
    format: "format",
    mime_type: "mimeType",
    original_file_name: "originalFileName",
    asset_size_bytes: "assetSizeBytes",
    created_at: "createdAt",
    updated_at: "updatedAt",
  },
  "wiki-timeline-v1": {
    id: "id",
    page_id: "pageId",
    at: "at",
    text: "text",
    created_at: "createdAt",
  },
} as const;

const TASK_OUTCOME_COLUMN_NAMES = {
  result: "result",
  error: "error",
  reported_status: "reportedStatus",
  outcome_comment: "comment",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
