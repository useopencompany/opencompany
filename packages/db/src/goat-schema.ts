import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { EncryptedPayload } from "@opencompany/crypto";
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export type GoatTaskStatus = "queued" | "running" | "succeeded" | "failed";

export type GoatTaskStage =
  | "queued"
  | "planning"
  | "sandboxing"
  | "running"
  | "completed"
  | "failed";

export type GoatIntegrationProvider = "gmail" | "google_calendar" | "linear" | "github";
export type GoatIntegrationStatus = "connected" | "needs_reauth" | "sync_failed" | "disconnected";
export type GoatIntegrationCredentialKind = "oauth_token";
export type GoatIntegrationCredentialEncryptedPayload = EncryptedPayload;
export type GoatIntegrationResourceStatus =
  | "available"
  | "permission_lost"
  | "archived"
  | "sync_failed";

export type GoatTaskToolName =
  | "exa_search"
  | "gmail_search"
  | "gmail_get_message"
  | "gmail_list_threads"
  | "gmail_get_thread"
  | "calendar_list_calendars"
  | "calendar_list_events"
  | "calendar_get_event"
  | "calendar_get_freebusy"
  | "linear_search_tools"
  | "linear_use_tool"
  | "github_clone_repository"
  | "github_shell"
  | "github_status"
  | "github_open_pull_request";

export type GoatHarnessSpec = {
  schemaVersion: "goat.harness.v1";
  model: AgentModelId;
  systemPrompt: string;
  initialUserMessage: string;
  tools: GoatTaskToolName[];
  maxModelSteps: number;
  resultMode: "assistant_final";
};

export type GoatBrainFolderSource = "system" | "custom";
export type GoatBrainRelation = {
  type?: string;
  target: string;
};
export type GoatBrainSource = {
  ref: string;
  title?: string;
  capturedAt?: string;
};
export type GoatBrainDocumentKind = "markdown" | "pdf" | "docx";
export type GoatBrainTimelineEntry = {
  at: string;
  body: string;
};
export type GoatBrainDocumentVersionOperation = "overwrite" | "delete";

export type GoatTaskMessageRole = "user" | "assistant" | "tool";
export type GoatTaskMessageStatus = "created" | "running" | "completed" | "failed";
export type GoatTaskModelUsagePhase = "planner" | "execution";

export type GoatTaskEventType =
  | "task.status"
  | "harness.planned"
  | "assistant.delta"
  | "message.created"
  | "message.completed"
  | "message.failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed";

export type GoatTaskEventPayload = Record<string, unknown>;

export type GoatTaskDebugTrace = {
  schemaVersion?: "goat.debug.v1";
  planner?: {
    model?: string;
    request?: {
      messages?: Array<{ role: string; content: string }>;
      responseFormat?: unknown;
    };
    response?: {
      content?: string | null;
    };
  };
  harness?: {
    model?: string;
    systemPrompt?: string;
    toolsSentToModel?: unknown[];
    toolChoice?: string;
    turns?: Array<{
      step: number;
      requestMessages?: unknown[];
      responseMessage?: unknown;
      toolResults?: unknown[];
    }>;
  };
};

export type GoatChatRole = "user" | "assistant";

export type GoatChatMessageDebugTrace = {
  schemaVersion?: "opencompany.chat.debug.v1" | "goat.chat.debug.v1";
  model?: string;
  finishReason?: string;
  uiMessageParts?: unknown[];
  toolCalls?: unknown[];
  toolResults?: unknown[];
  error?: string;
};

export const goat = pgSchema("goat");
export const goatTaskDisplayIdSequence = goat.sequence("task_display_id_seq");

export const goatUsers = goat.table("users", {
  workosUserId: text("workos_user_id").primaryKey(),
  email: text("email").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const goatBrainFolders = goat.table(
  "brain_folders",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    path: text("path").notNull(),
    source: text("source").$type<GoatBrainFolderSource>().notNull().default("custom"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userPathIdx: uniqueIndex("goat_brain_folders_user_path_idx").on(table.userWorkosId, table.path),
    userIdx: index("goat_brain_folders_user_idx").on(table.userWorkosId),
    sourceCheck: check(
      "goat_brain_folders_source_check",
      sql`${table.source} IN ('system', 'custom')`,
    ),
  }),
);

export const goatBrainDocuments = goat.table(
  "brain_documents",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    brainId: text("brain_id").notNull(),
    folderPath: text("folder_path").notNull(),
    title: text("title"),
    content: text("content").notNull().default(""),
    body: text("body").notNull().default(""),
    timeline: jsonb("timeline")
      .$type<GoatBrainTimelineEntry[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    kind: text("kind").$type<GoatBrainDocumentKind>().notNull().default("markdown"),
    mimeType: text("mime_type"),
    originalFileName: text("original_file_name"),
    assetStorageKey: text("asset_storage_key"),
    related: jsonb("related").$type<GoatBrainRelation[]>().notNull().default(sql`'[]'::jsonb`),
    sources: jsonb("sources").$type<GoatBrainSource[]>().notNull().default(sql`'[]'::jsonb`),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userBrainIdIdx: uniqueIndex("goat_brain_documents_user_brain_id_idx").on(
      table.userWorkosId,
      table.brainId,
    ),
    userFolderBrainIdx: uniqueIndex("goat_brain_documents_user_folder_brain_idx").on(
      table.userWorkosId,
      table.folderPath,
      table.brainId,
    ),
    userFolderUpdatedIdx: index("goat_brain_documents_user_folder_updated_idx").on(
      table.userWorkosId,
      table.folderPath,
      table.updatedAt,
    ),
    userUpdatedIdx: index("goat_brain_documents_user_updated_idx").on(
      table.userWorkosId,
      table.updatedAt,
    ),
    kindCheck: check(
      "goat_brain_documents_kind_check",
      sql`${table.kind} IN ('markdown', 'pdf', 'docx')`,
    ),
  }),
);

export const goatBrainDocumentVersions = goat.table(
  "brain_document_versions",
  {
    id: serial("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    documentId: text("document_id").references(() => goatBrainDocuments.id, {
      onDelete: "set null",
    }),
    taskId: text("task_id"),
    brainId: text("brain_id").notNull(),
    folderPath: text("folder_path").notNull(),
    content: text("content").notNull().default(""),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    operation: text("operation").$type<GoatBrainDocumentVersionOperation>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userDocumentCreatedIdx: index("goat_brain_document_versions_user_document_created_idx").on(
      table.userWorkosId,
      table.documentId,
      table.createdAt,
    ),
    userTaskCreatedIdx: index("goat_brain_document_versions_user_task_created_idx").on(
      table.userWorkosId,
      table.taskId,
      table.createdAt,
    ),
    operationCheck: check(
      "goat_brain_document_versions_operation_check",
      sql`${table.operation} IN ('overwrite', 'delete')`,
    ),
  }),
);

export const goatIntegrations = goat.table(
  "integrations",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    provider: text("provider").$type<GoatIntegrationProvider>().notNull(),
    externalId: text("external_id").notNull(),
    connectionLabel: text("connection_label"),
    accountName: text("account_name"),
    accountEmail: text("account_email"),
    accountType: text("account_type"),
    status: text("status").$type<GoatIntegrationStatus>().notNull().default("connected"),
    statusReason: text("status_reason"),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userProviderIdx: index("goat_integrations_user_provider_idx").on(
      table.userWorkosId,
      table.provider,
    ),
    userProviderExternalIdx: uniqueIndex("goat_integrations_user_provider_external_idx").on(
      table.userWorkosId,
      table.provider,
      table.externalId,
    ),
    integrationUserProviderIdx: uniqueIndex("goat_integrations_id_user_provider_idx").on(
      table.id,
      table.userWorkosId,
      table.provider,
    ),
    providerCheck: check(
      "goat_integrations_provider_check",
      sql`${table.provider} IN ('gmail', 'google_calendar', 'linear', 'github')`,
    ),
    statusCheck: check(
      "goat_integrations_status_check",
      sql`${table.status} IN ('connected', 'needs_reauth', 'sync_failed', 'disconnected')`,
    ),
  }),
);

export const goatIntegrationCredentials = goat.table(
  "integration_credentials",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    integrationId: text("integration_id").notNull(),
    provider: text("provider").$type<GoatIntegrationProvider>().notNull(),
    kind: text("kind").$type<GoatIntegrationCredentialKind>().notNull(),
    encryptedPayload: jsonb("encrypted_payload")
      .$type<GoatIntegrationCredentialEncryptedPayload>()
      .notNull(),
    encryptionKeyVersion: integer("encryption_key_version").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userProviderIdx: index("goat_integration_credentials_user_provider_idx").on(
      table.userWorkosId,
      table.provider,
    ),
    integrationIdx: index("goat_integration_credentials_integration_idx").on(table.integrationId),
    integrationKindIdx: uniqueIndex("goat_integration_credentials_integration_kind_idx").on(
      table.integrationId,
      table.kind,
    ),
    integrationUserProviderFk: foreignKey({
      name: "goat_integration_credentials_integration_user_provider_fk",
      columns: [table.integrationId, table.userWorkosId, table.provider],
      foreignColumns: [
        goatIntegrations.id,
        goatIntegrations.userWorkosId,
        goatIntegrations.provider,
      ],
    }).onDelete("cascade"),
    providerCheck: check(
      "goat_integration_credentials_provider_check",
      sql`${table.provider} IN ('gmail', 'google_calendar', 'linear', 'github')`,
    ),
    kindCheck: check(
      "goat_integration_credentials_kind_check",
      sql`${table.kind} IN ('oauth_token')`,
    ),
  }),
);

export const goatIntegrationResources = goat.table(
  "integration_resources",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    integrationId: text("integration_id").notNull(),
    provider: text("provider").$type<GoatIntegrationProvider>().notNull(),
    resourceType: text("resource_type").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    displayName: text("display_name"),
    status: text("status").$type<GoatIntegrationResourceStatus>().notNull().default("available"),
    statusReason: text("status_reason"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    selectedAt: timestamp("selected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userProviderTypeIdx: index("goat_integration_resources_user_provider_type_idx").on(
      table.userWorkosId,
      table.provider,
      table.resourceType,
    ),
    integrationIdx: index("goat_integration_resources_integration_idx").on(table.integrationId),
    integrationTypeExternalIdx: uniqueIndex(
      "goat_integration_resources_integration_type_external_idx",
    ).on(table.integrationId, table.resourceType, table.externalId),
    integrationUserProviderFk: foreignKey({
      name: "goat_integration_resources_integration_user_provider_fk",
      columns: [table.integrationId, table.userWorkosId, table.provider],
      foreignColumns: [
        goatIntegrations.id,
        goatIntegrations.userWorkosId,
        goatIntegrations.provider,
      ],
    }).onDelete("cascade"),
    providerCheck: check(
      "goat_integration_resources_provider_check",
      sql`${table.provider} IN ('gmail', 'google_calendar', 'linear', 'github')`,
    ),
    statusCheck: check(
      "goat_integration_resources_status_check",
      sql`${table.status} IN ('available', 'permission_lost', 'archived', 'sync_failed')`,
    ),
  }),
);

export const goatTasks = goat.table(
  "tasks",
  {
    id: text("id").primaryKey(),
    displayId: text("display_id")
      .notNull()
      .default(sql`'TASK-' || nextval('goat.task_display_id_seq')::text`),
    name: text("name").notNull().default("Untitled task"),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    model: text("model").$type<AgentModelId>().notNull(),
    status: text("status").$type<GoatTaskStatus>().notNull().default("queued"),
    stage: text("stage").$type<GoatTaskStage>().notNull().default("queued"),
    result: text("result"),
    error: text("error"),
    harnessSpec: jsonb("harness_spec").$type<GoatHarnessSpec>().notNull().default(sql`'{}'::jsonb`),
    debugTrace: jsonb("debug_trace")
      .$type<GoatTaskDebugTrace>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    sandboxId: text("sandbox_id"),
    attempts: integer("attempts").notNull().default(0),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull().defaultNow(),
    leaseId: text("lease_id"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    displayIdIdx: uniqueIndex("goat_tasks_display_id_idx").on(table.displayId),
    userCreatedAtIdx: index("goat_tasks_user_created_at_idx").on(
      table.userWorkosId,
      table.createdAt,
    ),
    userArchivedCreatedAtIdx: index("goat_tasks_user_archived_created_at_idx").on(
      table.userWorkosId,
      table.archivedAt,
      table.createdAt,
    ),
    statusNextRunAtIdx: index("goat_tasks_status_next_run_at_idx").on(
      table.status,
      table.nextRunAt,
    ),
    leaseExpiresAtIdx: index("goat_tasks_lease_expires_at_idx").on(table.leaseExpiresAt),
    statusCheck: check(
      "goat_tasks_status_check",
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed')`,
    ),
    stageCheck: check(
      "goat_tasks_stage_check",
      sql`${table.stage} IN ('queued', 'planning', 'sandboxing', 'running', 'completed', 'failed')`,
    ),
  }),
);

export const goatTaskMessages = goat.table(
  "task_messages",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => goatTasks.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    role: text("role").$type<GoatTaskMessageRole>().notNull(),
    status: text("status").$type<GoatTaskMessageStatus>().notNull().default("created"),
    content: text("content").notNull().default(""),
    modelMessage: jsonb("model_message").$type<unknown>(),
    toolName: text("tool_name").$type<GoatTaskToolName>(),
    toolCallId: text("tool_call_id"),
    responseToMessageId: text("response_to_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    userTaskCreatedAtIdx: index("goat_task_messages_user_task_created_at_idx").on(
      table.userWorkosId,
      table.taskId,
      table.createdAt,
    ),
    taskCreatedAtIdx: index("goat_task_messages_task_created_at_idx").on(
      table.taskId,
      table.createdAt,
    ),
    taskResponseToMessageIdx: uniqueIndex("goat_task_messages_task_response_to_message_idx").on(
      table.taskId,
      table.responseToMessageId,
    ),
    roleCheck: check(
      "goat_task_messages_role_check",
      sql`${table.role} IN ('user', 'assistant', 'tool')`,
    ),
    statusCheck: check(
      "goat_task_messages_status_check",
      sql`${table.status} IN ('created', 'running', 'completed', 'failed')`,
    ),
  }),
);

export const goatTaskEvents = goat.table(
  "task_events",
  {
    id: serial("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => goatTasks.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => goatTaskMessages.id, { onDelete: "set null" }),
    type: text("type").$type<GoatTaskEventType>().notNull(),
    payload: jsonb("payload").$type<GoatTaskEventPayload>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userTaskIdIdx: index("goat_task_events_user_task_id_idx").on(
      table.userWorkosId,
      table.taskId,
      table.id,
    ),
    taskIdIdx: index("goat_task_events_task_id_idx").on(table.taskId, table.id),
  }),
);

export const goatTaskModelUsage = goat.table(
  "task_model_usage",
  {
    id: serial("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => goatTasks.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => goatTaskMessages.id, {
      onDelete: "set null",
    }),
    runLeaseId: text("run_lease_id"),
    phase: text("phase").$type<GoatTaskModelUsagePhase>().notNull(),
    stepIndex: integer("step_index").notNull().default(0),
    modelProvider: text("model_provider").notNull(),
    modelName: text("model_name").notNull(),
    responseId: text("response_id"),
    responseModelId: text("response_model_id"),
    finishReason: text("finish_reason"),
    rawFinishReason: text("raw_finish_reason"),
    inputTokens: integer("input_tokens").notNull().default(0),
    inputNoCacheTokens: integer("input_no_cache_tokens").notNull().default(0),
    inputCacheReadTokens: integer("input_cache_read_tokens").notNull().default(0),
    inputCacheWriteTokens: integer("input_cache_write_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    outputTextTokens: integer("output_text_tokens").notNull().default(0),
    outputReasoningTokens: integer("output_reasoning_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    rawUsage: jsonb("raw_usage")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }),
    providerCostUsdMicros: bigint("provider_cost_usd_micros", { mode: "number" })
      .notNull()
      .default(0),
    platformFeeUsdMicros: bigint("platform_fee_usd_micros", { mode: "number" })
      .notNull()
      .default(0),
    totalCostUsdMicros: bigint("total_cost_usd_micros", { mode: "number" }).notNull().default(0),
    costBasis: jsonb("cost_basis")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userTaskCreatedAtIdx: index("goat_task_model_usage_user_task_created_at_idx").on(
      table.userWorkosId,
      table.taskId,
      table.createdAt,
    ),
    taskCreatedAtIdx: index("goat_task_model_usage_task_created_at_idx").on(
      table.taskId,
      table.createdAt,
    ),
    messageIdx: index("goat_task_model_usage_message_idx").on(table.messageId),
    phaseCheck: check(
      "goat_task_model_usage_phase_check",
      sql`${table.phase} IN ('planner', 'execution')`,
    ),
  }),
);

export const goatTaskToolUsage = goat.table(
  "task_tool_usage",
  {
    id: serial("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => goatTasks.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => goatTaskMessages.id, {
      onDelete: "set null",
    }),
    runLeaseId: text("run_lease_id"),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").$type<GoatTaskToolName>().notNull(),
    provider: text("provider").notNull(),
    operation: text("operation").notNull(),
    providerRequestId: text("provider_request_id"),
    providerCostUsdMicros: bigint("provider_cost_usd_micros", { mode: "number" })
      .notNull()
      .default(0),
    platformFeeUsdMicros: bigint("platform_fee_usd_micros", { mode: "number" })
      .notNull()
      .default(0),
    totalCostUsdMicros: bigint("total_cost_usd_micros", { mode: "number" }).notNull().default(0),
    rawUsage: jsonb("raw_usage")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    costBasis: jsonb("cost_basis")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userTaskCreatedAtIdx: index("goat_task_tool_usage_user_task_created_at_idx").on(
      table.userWorkosId,
      table.taskId,
      table.createdAt,
    ),
    taskCreatedAtIdx: index("goat_task_tool_usage_task_created_at_idx").on(
      table.taskId,
      table.createdAt,
    ),
    messageIdx: index("goat_task_tool_usage_message_idx").on(table.messageId),
    toolCallIdx: index("goat_task_tool_usage_tool_call_idx").on(table.toolCallId),
  }),
);

export const goatTaskSandboxUsage = goat.table(
  "task_sandbox_usage",
  {
    id: serial("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => goatTasks.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => goatTaskMessages.id, {
      onDelete: "set null",
    }),
    runLeaseId: text("run_lease_id"),
    sandboxId: text("sandbox_id").notNull(),
    template: text("template"),
    vcpu: integer("vcpu"),
    ramMib: integer("ram_mib"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    activeMs: integer("active_ms").notNull().default(0),
    providerCostUsdMicros: bigint("provider_cost_usd_micros", { mode: "number" })
      .notNull()
      .default(0),
    platformFeeUsdMicros: bigint("platform_fee_usd_micros", { mode: "number" })
      .notNull()
      .default(0),
    totalCostUsdMicros: bigint("total_cost_usd_micros", { mode: "number" }).notNull().default(0),
    rawMetrics: jsonb("raw_metrics")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    costBasis: jsonb("cost_basis")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userTaskCreatedAtIdx: index("goat_task_sandbox_usage_user_task_created_at_idx").on(
      table.userWorkosId,
      table.taskId,
      table.createdAt,
    ),
    taskCreatedAtIdx: index("goat_task_sandbox_usage_task_created_at_idx").on(
      table.taskId,
      table.createdAt,
    ),
    messageIdx: index("goat_task_sandbox_usage_message_idx").on(table.messageId),
    sandboxIdx: index("goat_task_sandbox_usage_sandbox_idx").on(table.sandboxId),
  }),
);

export const goatChatSessions = goat.table(
  "chat_sessions",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    title: text("title").notNull().default("New chat"),
    model: text("model").$type<AgentModelId>().notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userOpenUpdatedIdx: index("goat_chat_sessions_user_open_updated_idx").on(
      table.userWorkosId,
      table.closedAt,
      table.updatedAt,
    ),
  }),
);

export const goatChatMessages = goat.table(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => goatChatSessions.id, { onDelete: "cascade" }),
    role: text("role").$type<GoatChatRole>().notNull(),
    content: text("content").notNull().default(""),
    taskId: text("task_id").references(() => goatTasks.id, { onDelete: "set null" }),
    debugTrace: jsonb("debug_trace").$type<GoatChatMessageDebugTrace | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionCreatedAtIdx: index("goat_chat_messages_session_created_at_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    taskIdx: index("goat_chat_messages_task_idx").on(table.taskId),
    roleCheck: check("goat_chat_messages_role_check", sql`${table.role} IN ('user', 'assistant')`),
  }),
);

export const goatUsersRelations = relations(goatUsers, ({ many }) => ({
  brainFolders: many(goatBrainFolders),
  brainDocuments: many(goatBrainDocuments),
  brainDocumentVersions: many(goatBrainDocumentVersions),
  tasks: many(goatTasks),
  taskMessages: many(goatTaskMessages),
  taskEvents: many(goatTaskEvents),
  taskModelUsage: many(goatTaskModelUsage),
  taskToolUsage: many(goatTaskToolUsage),
  taskSandboxUsage: many(goatTaskSandboxUsage),
  chatSessions: many(goatChatSessions),
  integrations: many(goatIntegrations),
  integrationCredentials: many(goatIntegrationCredentials),
  integrationResources: many(goatIntegrationResources),
}));

export const goatBrainFoldersRelations = relations(goatBrainFolders, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatBrainFolders.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
}));

export const goatBrainDocumentsRelations = relations(goatBrainDocuments, ({ one, many }) => ({
  user: one(goatUsers, {
    fields: [goatBrainDocuments.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  versions: many(goatBrainDocumentVersions),
}));

export const goatBrainDocumentVersionsRelations = relations(
  goatBrainDocumentVersions,
  ({ one }) => ({
    user: one(goatUsers, {
      fields: [goatBrainDocumentVersions.userWorkosId],
      references: [goatUsers.workosUserId],
    }),
    document: one(goatBrainDocuments, {
      fields: [goatBrainDocumentVersions.documentId],
      references: [goatBrainDocuments.id],
    }),
  }),
);

export const goatIntegrationsRelations = relations(goatIntegrations, ({ one, many }) => ({
  user: one(goatUsers, {
    fields: [goatIntegrations.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  credentials: many(goatIntegrationCredentials),
  resources: many(goatIntegrationResources),
}));

export const goatIntegrationCredentialsRelations = relations(
  goatIntegrationCredentials,
  ({ one }) => ({
    user: one(goatUsers, {
      fields: [goatIntegrationCredentials.userWorkosId],
      references: [goatUsers.workosUserId],
    }),
    integration: one(goatIntegrations, {
      fields: [goatIntegrationCredentials.integrationId],
      references: [goatIntegrations.id],
    }),
  }),
);

export const goatIntegrationResourcesRelations = relations(goatIntegrationResources, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatIntegrationResources.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  integration: one(goatIntegrations, {
    fields: [goatIntegrationResources.integrationId],
    references: [goatIntegrations.id],
  }),
}));

export const goatTasksRelations = relations(goatTasks, ({ one, many }) => ({
  user: one(goatUsers, {
    fields: [goatTasks.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  taskMessages: many(goatTaskMessages),
  taskEvents: many(goatTaskEvents),
  modelUsage: many(goatTaskModelUsage),
  toolUsage: many(goatTaskToolUsage),
  sandboxUsage: many(goatTaskSandboxUsage),
  chatMessages: many(goatChatMessages),
}));

export const goatTaskMessagesRelations = relations(goatTaskMessages, ({ one, many }) => ({
  user: one(goatUsers, {
    fields: [goatTaskMessages.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  task: one(goatTasks, {
    fields: [goatTaskMessages.taskId],
    references: [goatTasks.id],
  }),
  events: many(goatTaskEvents),
  modelUsage: many(goatTaskModelUsage),
  toolUsage: many(goatTaskToolUsage),
  sandboxUsage: many(goatTaskSandboxUsage),
}));

export const goatTaskEventsRelations = relations(goatTaskEvents, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatTaskEvents.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  task: one(goatTasks, {
    fields: [goatTaskEvents.taskId],
    references: [goatTasks.id],
  }),
  message: one(goatTaskMessages, {
    fields: [goatTaskEvents.messageId],
    references: [goatTaskMessages.id],
  }),
}));

export const goatTaskModelUsageRelations = relations(goatTaskModelUsage, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatTaskModelUsage.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  task: one(goatTasks, {
    fields: [goatTaskModelUsage.taskId],
    references: [goatTasks.id],
  }),
  message: one(goatTaskMessages, {
    fields: [goatTaskModelUsage.messageId],
    references: [goatTaskMessages.id],
  }),
}));

export const goatTaskToolUsageRelations = relations(goatTaskToolUsage, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatTaskToolUsage.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  task: one(goatTasks, {
    fields: [goatTaskToolUsage.taskId],
    references: [goatTasks.id],
  }),
  message: one(goatTaskMessages, {
    fields: [goatTaskToolUsage.messageId],
    references: [goatTaskMessages.id],
  }),
}));

export const goatTaskSandboxUsageRelations = relations(goatTaskSandboxUsage, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatTaskSandboxUsage.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  task: one(goatTasks, {
    fields: [goatTaskSandboxUsage.taskId],
    references: [goatTasks.id],
  }),
  message: one(goatTaskMessages, {
    fields: [goatTaskSandboxUsage.messageId],
    references: [goatTaskMessages.id],
  }),
}));

export const goatChatSessionsRelations = relations(goatChatSessions, ({ one, many }) => ({
  user: one(goatUsers, {
    fields: [goatChatSessions.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  messages: many(goatChatMessages),
}));

export const goatChatMessagesRelations = relations(goatChatMessages, ({ one }) => ({
  session: one(goatChatSessions, {
    fields: [goatChatMessages.sessionId],
    references: [goatChatSessions.id],
  }),
  task: one(goatTasks, {
    fields: [goatChatMessages.taskId],
    references: [goatTasks.id],
  }),
}));

export type GoatUser = typeof goatUsers.$inferSelect;
export type GoatBrainFolder = typeof goatBrainFolders.$inferSelect;
export type GoatBrainDocument = typeof goatBrainDocuments.$inferSelect;
export type GoatBrainDocumentVersion = typeof goatBrainDocumentVersions.$inferSelect;
export type GoatIntegration = typeof goatIntegrations.$inferSelect;
export type GoatIntegrationCredential = typeof goatIntegrationCredentials.$inferSelect;
export type GoatTask = typeof goatTasks.$inferSelect;
export type GoatTaskMessage = typeof goatTaskMessages.$inferSelect;
export type GoatTaskEvent = typeof goatTaskEvents.$inferSelect;
export type GoatTaskModelUsage = typeof goatTaskModelUsage.$inferSelect;
export type GoatTaskToolUsage = typeof goatTaskToolUsage.$inferSelect;
export type GoatTaskSandboxUsage = typeof goatTaskSandboxUsage.$inferSelect;
export type GoatChatSession = typeof goatChatSessions.$inferSelect;
export type GoatChatMessage = typeof goatChatMessages.$inferSelect;
