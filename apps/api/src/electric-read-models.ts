import type { Actor } from "@opencompany/core";
import {
  type ChatReadModel,
  ConversationReadModelSchema,
  MessageReadModelSchema,
  RunReadModelSchema,
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

// These columns cross the API boundary as decoded JSON values. Omitting their upstream JSONB
// metadata prevents @electric-sql/client from parsing the already-decoded values a second time.
const PREDECODED_READ_MODEL_FIELDS = new Set(["presentation", "attachments"]);

export interface ChatReadModelService {
  stream(input: {
    actor: Actor;
    readModel: ChatReadModel;
    conversationId?: string;
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

export class ElectricChatReadModelProxy implements ChatReadModelService {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: ElectricReadModelProxyOptions) {
    if (Boolean(options.sourceId) !== Boolean(options.sourceSecret)) {
      throw new Error("Electric source credentials must be configured together.");
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async stream(input: {
    actor: Actor;
    readModel: ChatReadModel;
    conversationId?: string;
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
  readModel: ChatReadModel;
  conversationId?: string;
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
    default:
      throw new ApiError(400, "invalid_request", "Unknown Chat read model.");
  }
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
      `"conversation_id" = $1 AND "actor_id" = $2 ` +
      `AND ("workspace_id" = $3 OR "workspace_id" IS NULL)`,
    params: [input.conversationId, input.actor.userId, input.actor.workspaceId],
  };
}

function projectElectricEntry(readModel: ChatReadModel, entry: unknown) {
  if (!isRecord(entry) || !isRecord(entry.value)) return entry;
  const operation = isRecord(entry.headers) ? entry.headers.operation : undefined;
  return {
    key: entry.key,
    headers: entry.headers,
    value: projectReadModelValue(readModel, entry.value, operation !== "insert"),
  };
}

function projectReadModelValue(
  readModel: ChatReadModel,
  row: Record<string, unknown>,
  partial: boolean,
) {
  const columnNames = READ_MODEL_COLUMN_NAMES[
    readModel as keyof typeof READ_MODEL_COLUMN_NAMES
  ] as Record<string, string>;
  const projected = Object.fromEntries(
    Object.entries(columnNames).flatMap(([physicalName, publicName]) =>
      Object.hasOwn(row, physicalName)
        ? [[publicName, readModelFieldValue(publicName, row[physicalName])]]
        : [],
    ),
  );
  switch (readModel) {
    case "chat-conversations-v1":
      return (partial ? ConversationReadModelSchema.partial() : ConversationReadModelSchema).parse(
        projected,
      );
    case "chat-messages-v1":
      return (partial ? MessageReadModelSchema.partial() : MessageReadModelSchema).parse(projected);
    case "chat-runs-v1":
      return (partial ? RunReadModelSchema.partial() : RunReadModelSchema).parse(projected);
  }
}

function readModelFieldValue(name: string, value: unknown) {
  if (name.endsWith("At")) return timestampValue(value);
  if (name === "attemptCount") return numberValue(value);
  if (name === "presentation") return jsonValue(value);
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

function electricNoContentResponse(upstream: Response, readModel: ChatReadModel) {
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

function electricRecoveryResponse(upstream: Response, readModel: ChatReadModel) {
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

function safeElectricHeaders(source: Headers, readModel: ChatReadModel) {
  const headers = new Headers(source);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("set-cookie");
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
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
