import type { AgentModelId, CodexReasoningEffort } from "@opencompany/agent-runtime/types";
import type { EncryptedPayload } from "@opencompany/crypto";
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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

export type GoatTaskStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type GoatHarnessEngine = "opencompany" | "codex";

export type GoatTaskStage =
  | "queued"
  | "planning"
  | "sandboxing"
  | "running"
  | "completed"
  | "failed"
  | "canceled";
export type GoatTaskScheduleRunStatus = "pending" | "created" | "failed";

export type GoatIntegrationProvider = "gmail" | "google_calendar" | "linear" | "github" | "jamie";
export type GoatIntegrationStatus = "connected" | "needs_reauth" | "sync_failed" | "disconnected";
export type GoatIntegrationCredentialKind = "oauth_token" | "webhook_secret";
export type GoatIntegrationCredentialEncryptedPayload = EncryptedPayload;
export type GoatCodexCredentialStatus = "connected" | "needs_reauth";
export type GoatCodexDeviceAuthFlowStatus =
  | "pending"
  | "code_ready"
  | "completed"
  | "failed"
  | "expired";
export type GoatIntegrationResourceStatus =
  | "available"
  | "permission_lost"
  | "archived"
  | "sync_failed";
export type GoatBrainSourceProvider = "jamie" | "goat-chat" | "upload";
export type GoatBrainSourceConfigProvider = "jamie" | "gmail" | "github" | "slack";
export type GoatBrainSourceType = "meeting" | "capture" | "asset";
export type GoatBrainSourceItemIngestStatus = "pending" | "succeeded" | "failed";
export type GoatBrainIngestJobKind = "brain_source_item_ingest" | "brain_agent_ingest";
export type GoatBrainIngestJobStatus = "queued" | "running" | "succeeded" | "failed";

export type GoatTaskToolName =
  | "exa_search"
  | "browser_open"
  | "browser_snapshot"
  | "browser_click"
  | "browser_fill"
  | "browser_wait"
  | "browser_read"
  | "browser_get"
  | "browser_find"
  | "browser_scroll"
  | "browser_screenshot"
  | "browser_close"
  | "x_search_posts"
  | "x_get_profile"
  | "x_get_user_posts"
  | "x_get_discussion"
  | "social_get_job"
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

export type GoatTaskSkillId = "first-principles" | "yc-office-hours";

export type GoatHarnessSpec = {
  schemaVersion: "goat.harness.v1";
  engine: GoatHarnessEngine;
  model: AgentModelId;
  systemPrompt: string;
  initialUserMessage: string;
  tools: GoatTaskToolName[];
  skills: GoatTaskSkillId[];
  maxModelSteps: number;
  resultMode: "assistant_final" | "brain_markdown_report";
  codex?: {
    repository?: string | null;
    createPullRequest?: boolean;
    reasoningEffort?: CodexReasoningEffort;
    goalMode?: {
      objective: string;
      tokenBudget?: number | null;
    };
  };
};

export type GoatWorkspaceRole = "admin" | "member";
export type GoatBrainVisibility = "workspace" | "restricted";
export type GoatBrainFolderSource = "system" | "custom";
export type GoatBrainEntityType =
  | "person"
  | "company"
  | "project"
  | "meeting"
  | "concept"
  | "source"
  | "analysis"
  | "note";
export type GoatBrainKind = "page" | "evidence";
export type GoatBrainRelation = {
  type: string;
  to: string;
};
export type GoatBrainEdgeSourceKind = "relation" | "wiki_link";
export type GoatBrainSource = {
  ref: string;
  title?: string;
  capturedAt?: string;
};
export type GoatBrainDocumentFormat = "markdown" | "pdf" | "docx";
export type GoatBrainStatus = "draft" | "active" | "archived" | "merged";
export type GoatBrainFrontmatterProjection = Record<string, unknown>;
export type GoatBrainTimelineEntry = {
  evidenceId: string;
  at: string;
  body: string;
};
export type GoatBrainTimelineEntryRow = {
  evidenceId: string;
  at: string;
  summary: string;
  detail: string;
  sourceRef: string;
  sourceTitle?: string | null;
};
export type GoatBrainDocumentVersionOperation = "overwrite" | "delete";

export type GoatTaskMessageRole = "user" | "assistant" | "tool";
export type GoatTaskMessageStatus = "created" | "running" | "completed" | "failed";
export type GoatTaskModelUsagePhase = "planner" | "execution";

export type GoatTaskEventType =
  | "task.status"
  | "harness.planned"
  | "artifact.created"
  | "assistant.delta"
  | "reasoning.completed"
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
  aborted?: boolean;
  finishReason?: string;
  uiMessageParts?: unknown[];
  toolCalls?: unknown[];
  toolResults?: unknown[];
  error?: string;
};

export type GoatBrainToolRunTrace = Record<string, unknown>;

export const goat = pgSchema("goat");
export const goatTaskDisplayIdSequence = goat.sequence("task_display_id_seq");

export const goatUsers = goat.table("users", {
  workosUserId: text("workos_user_id").primaryKey(),
  email: text("email").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  avatarUrl: text("avatar_url"),
  timezone: text("timezone").notNull().default("UTC"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const goatWorkspaces = goat.table(
  "workspaces",
  {
    id: text("id").primaryKey(),
    workosOrganizationId: text("workos_organization_id"),
    name: text("name").notNull(),
    createdByWorkosId: text("created_by_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workosOrganizationIdx: uniqueIndex("goat_workspaces_workos_organization_idx").on(
      table.workosOrganizationId,
    ),
  }),
);

export const goatWorkspaceMembers = goat.table(
  "workspace_members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => goatWorkspaces.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    role: text("role").$type<GoatWorkspaceRole>().notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceUserIdx: uniqueIndex("goat_workspace_members_workspace_user_idx").on(
      table.workspaceId,
      table.userWorkosId,
    ),
    userIdx: index("goat_workspace_members_user_idx").on(table.userWorkosId),
    roleCheck: check(
      "goat_workspace_members_role_check",
      sql`${table.role} IN ('admin', 'member')`,
    ),
  }),
);

// Naming convention: on the brain content tables below, `brain_id` is the
// DOCUMENT slug (legacy name, e.g. "alice-smith"), while `brain_ref` is the
// FK to `goat.brains.id` — the brain a row belongs to.
export const goatBrains = goat.table(
  "brains",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => goatWorkspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    visibility: text("visibility").$type<GoatBrainVisibility>().notNull().default("workspace"),
    createdByWorkosId: text("created_by_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceSlugIdx: uniqueIndex("goat_brains_workspace_slug_idx").on(
      table.workspaceId,
      table.slug,
    ),
    workspaceIdx: index("goat_brains_workspace_idx").on(table.workspaceId),
    visibilityCheck: check(
      "goat_brains_visibility_check",
      sql`${table.visibility} IN ('workspace', 'restricted')`,
    ),
  }),
);

export const goatBrainMembers = goat.table(
  "brain_members",
  {
    id: text("id").primaryKey(),
    brainId: text("brain_id")
      .notNull()
      .references(() => goatBrains.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    addedByWorkosId: text("added_by_workos_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    brainUserIdx: uniqueIndex("goat_brain_members_brain_user_idx").on(
      table.brainId,
      table.userWorkosId,
    ),
    userIdx: index("goat_brain_members_user_idx").on(table.userWorkosId),
  }),
);

export const goatBrainFolders = goat.table(
  "brain_folders",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    brainRef: text("brain_ref")
      .notNull()
      .references(() => goatBrains.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    source: text("source").$type<GoatBrainFolderSource>().notNull().default("custom"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    brainRefPathIdx: uniqueIndex("goat_brain_folders_brain_ref_path_idx").on(
      table.brainRef,
      table.path,
    ),
    brainRefIdx: index("goat_brain_folders_brain_ref_idx").on(table.brainRef),
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
    brainRef: text("brain_ref")
      .notNull()
      .references(() => goatBrains.id, { onDelete: "cascade" }),
    brainId: text("brain_id").notNull(),
    folderPath: text("folder_path").notNull(),
    title: text("title"),
    content: text("content").notNull().default(""),
    body: text("body").notNull().default(""),
    timeline: jsonb("timeline")
      .$type<GoatBrainTimelineEntry[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    format: text("format").$type<GoatBrainDocumentFormat>().notNull().default("markdown"),
    mimeType: text("mime_type"),
    originalFileName: text("original_file_name"),
    assetStorageKey: text("asset_storage_key"),
    // Machine-extracted text of the binary asset (search + agent context);
    // regenerated by ingestion, never user-edited. Null for markdown rows.
    assetExtractedText: text("asset_extracted_text"),
    // sha256 + size of the blob bytes (the contentHash/sizeBytes columns
    // describe the markdown projection in `content`, not the asset).
    assetContentHash: text("asset_content_hash"),
    assetSizeBytes: integer("asset_size_bytes"),
    relations: jsonb("relations").$type<GoatBrainRelation[]>().notNull().default(sql`'[]'::jsonb`),
    sources: jsonb("sources").$type<GoatBrainSource[]>().notNull().default(sql`'[]'::jsonb`),
    kind: text("kind").$type<GoatBrainKind>().notNull(),
    entityType: text("entity_type").$type<GoatBrainEntityType>().notNull(),
    status: text("status").$type<GoatBrainStatus>().notNull().default("draft"),
    aliases: jsonb("aliases").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    brainRefBrainIdIdx: uniqueIndex("goat_brain_documents_brain_ref_brain_id_idx").on(
      table.brainRef,
      table.brainId,
    ),
    brainRefFolderBrainIdx: uniqueIndex("goat_brain_documents_brain_ref_folder_brain_idx").on(
      table.brainRef,
      table.folderPath,
      table.brainId,
    ),
    brainRefFolderUpdatedIdx: index("goat_brain_documents_brain_ref_folder_updated_idx").on(
      table.brainRef,
      table.folderPath,
      table.updatedAt,
    ),
    brainRefUpdatedIdx: index("goat_brain_documents_brain_ref_updated_idx").on(
      table.brainRef,
      table.updatedAt,
    ),
    formatCheck: check(
      "goat_brain_documents_format_check",
      sql`${table.format} IN ('markdown', 'pdf', 'docx')`,
    ),
    statusCheck: check(
      "goat_brain_documents_status_check",
      sql`${table.status} IN ('draft', 'active', 'archived', 'merged')`,
    ),
    kindCheck: check("goat_brain_documents_kind_check", sql`${table.kind} IN ('page', 'evidence')`),
    entityTypeCheck: check(
      "goat_brain_documents_entity_type_check",
      sql`${table.entityType} IN ('person', 'company', 'project', 'meeting', 'concept', 'source', 'analysis', 'note')`,
    ),
    kindZoneCheck: check(
      "goat_brain_documents_kind_zone_check",
      sql`(
        (${table.kind} = 'evidence' AND (${table.folderPath} = 'evidence' OR ${table.folderPath} LIKE 'evidence/%')) OR
        (${table.kind} = 'page' AND ${table.folderPath} <> 'evidence' AND ${table.folderPath} NOT LIKE 'evidence/%')
      )`,
    ),
  }),
);

export const goatBrainTimelineEntries = goat.table(
  "brain_timeline_entries",
  {
    id: serial("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => goatBrainDocuments.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    brainRef: text("brain_ref")
      .notNull()
      .references(() => goatBrains.id, { onDelete: "cascade" }),
    brainId: text("brain_id").notNull(),
    evidenceId: text("evidence_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    sourceRef: text("source_ref").notNull().default(""),
    sourceTitle: text("source_title"),
    summary: text("summary").notNull(),
    detail: text("detail").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    brainRefBrainAtIdx: index("goat_brain_timeline_entries_brain_ref_brain_at_idx").on(
      table.brainRef,
      table.brainId,
      table.at,
    ),
    documentAtIdx: index("goat_brain_timeline_entries_document_at_idx").on(
      table.documentId,
      table.at,
    ),
    dedupIdx: uniqueIndex("goat_brain_timeline_entries_dedup_idx").on(
      table.documentId,
      table.evidenceId,
    ),
  }),
);

export const goatBrainEdges = goat.table(
  "brain_edges",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    brainRef: text("brain_ref")
      .notNull()
      .references(() => goatBrains.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => goatBrainDocuments.id, { onDelete: "cascade" }),
    fromBrainId: text("from_brain_id").notNull(),
    toBrainId: text("to_brain_id").notNull(),
    relationType: text("relation_type").notNull(),
    sourceKind: text("source_kind").$type<GoatBrainEdgeSourceKind>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentIdx: index("goat_brain_edges_document_idx").on(table.documentId),
    brainRefFromIdx: index("goat_brain_edges_brain_ref_from_idx").on(
      table.brainRef,
      table.fromBrainId,
    ),
    brainRefToIdx: index("goat_brain_edges_brain_ref_to_idx").on(table.brainRef, table.toBrainId),
    brainRefRelationIdx: index("goat_brain_edges_brain_ref_relation_idx").on(
      table.brainRef,
      table.relationType,
    ),
    uniqueEdgeIdx: uniqueIndex("goat_brain_edges_unique_idx").on(
      table.brainRef,
      table.documentId,
      table.fromBrainId,
      table.toBrainId,
      table.relationType,
      table.sourceKind,
    ),
    sourceKindCheck: check(
      "goat_brain_edges_source_kind_check",
      sql`${table.sourceKind} IN ('relation', 'wiki_link')`,
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
    brainRef: text("brain_ref").references(() => goatBrains.id, { onDelete: "set null" }),
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
      sql`${table.provider} IN ('gmail', 'google_calendar', 'linear', 'github', 'jamie')`,
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
      sql`${table.provider} IN ('gmail', 'google_calendar', 'linear', 'github', 'jamie')`,
    ),
    kindCheck: check(
      "goat_integration_credentials_kind_check",
      sql`${table.kind} IN ('oauth_token', 'webhook_secret')`,
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
      sql`${table.provider} IN ('gmail', 'google_calendar', 'linear', 'github', 'jamie')`,
    ),
    statusCheck: check(
      "goat_integration_resources_status_check",
      sql`${table.status} IN ('available', 'permission_lost', 'archived', 'sync_failed')`,
    ),
  }),
);

// Per-brain source configuration: which user-owned integration feeds which brain.
export const goatBrainSources = goat.table(
  "brain_sources",
  {
    id: text("id").primaryKey(),
    brainId: text("brain_id")
      .notNull()
      .references(() => goatBrains.id, { onDelete: "cascade" }),
    provider: text("provider").$type<GoatBrainSourceConfigProvider>().notNull(),
    integrationId: text("integration_id").notNull(),
    // Owner of the referenced integration (integrations are user-scoped;
    // brains are workspace-shared, so the row records whose connection feeds the brain).
    userWorkosId: text("user_workos_id").notNull(),
    createdByWorkosId: text("created_by_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    brainIntegrationIdx: uniqueIndex("goat_brain_sources_brain_integration_idx").on(
      table.brainId,
      table.integrationId,
    ),
    integrationIdx: index("goat_brain_sources_integration_idx").on(table.integrationId),
    brainIdx: index("goat_brain_sources_brain_idx").on(table.brainId),
    integrationUserProviderFk: foreignKey({
      name: "goat_brain_sources_integration_user_provider_fk",
      columns: [table.integrationId, table.userWorkosId, table.provider],
      foreignColumns: [
        goatIntegrations.id,
        goatIntegrations.userWorkosId,
        goatIntegrations.provider,
      ],
    }).onDelete("cascade"),
    providerCheck: check(
      "goat_brain_sources_provider_check",
      sql`${table.provider} IN ('jamie', 'gmail', 'github', 'slack')`,
    ),
  }),
);

export const goatBrainSourceItems = goat.table(
  "brain_source_items",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    sourceProvider: text("source_provider").$type<GoatBrainSourceProvider>().notNull(),
    sourceConnectionId: text("source_connection_id").notNull(),
    integrationId: text("integration_id"),
    sourceType: text("source_type").$type<GoatBrainSourceType>().notNull(),
    externalId: text("external_id").notNull(),
    sourceRef: text("source_ref").notNull(),
    title: text("title"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    contentHash: text("content_hash").notNull(),
    rawPayload: jsonb("raw_payload").$type<unknown>().notNull(),
    normalizedPayload: jsonb("normalized_payload").$type<unknown>().notNull(),
    lastIngestJobId: text("last_ingest_job_id"),
    lastIngestStatus: text("last_ingest_status").$type<GoatBrainSourceItemIngestStatus>(),
    lastIngestedAt: timestamp("last_ingested_at", { withTimezone: true }),
    lastIngestError: text("last_ingest_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceConnectionExternalHashIdx: uniqueIndex(
      "goat_brain_source_items_connection_external_hash_idx",
    ).on(
      table.userWorkosId,
      table.sourceProvider,
      table.sourceConnectionId,
      table.sourceType,
      table.externalId,
      table.contentHash,
    ),
    userSourceProviderOccurredIdx: index("goat_brain_source_items_user_provider_occurred_idx").on(
      table.userWorkosId,
      table.sourceProvider,
      table.occurredAt,
    ),
    userUpdatedIdx: index("goat_brain_source_items_user_updated_idx").on(
      table.userWorkosId,
      table.updatedAt,
    ),
    lastIngestStatusIdx: index("goat_brain_source_items_last_ingest_status_idx").on(
      table.lastIngestStatus,
      table.updatedAt,
    ),
    integrationUserProviderFk: foreignKey({
      name: "goat_brain_source_items_integration_user_provider_fk",
      columns: [table.integrationId, table.userWorkosId, table.sourceProvider],
      foreignColumns: [
        goatIntegrations.id,
        goatIntegrations.userWorkosId,
        goatIntegrations.provider,
      ],
    }).onDelete("cascade"),
    sourceProviderCheck: check(
      "goat_brain_source_items_source_provider_check",
      sql`${table.sourceProvider} IN ('jamie', 'goat-chat', 'upload')`,
    ),
    sourceTypeCheck: check(
      "goat_brain_source_items_source_type_check",
      sql`${table.sourceType} IN ('meeting', 'capture', 'asset')`,
    ),
    lastIngestStatusCheck: check(
      "goat_brain_source_items_last_ingest_status_check",
      sql`${table.lastIngestStatus} IS NULL OR ${table.lastIngestStatus} IN ('pending', 'succeeded', 'failed')`,
    ),
  }),
);

export const goatBrainIngestJobs = goat.table(
  "brain_ingest_jobs",
  {
    id: text("id").primaryKey(),
    sourceItemId: text("source_item_id")
      .notNull()
      .references(() => goatBrainSourceItems.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    sourceProvider: text("source_provider").$type<GoatBrainSourceProvider>().notNull(),
    sourceConnectionId: text("source_connection_id").notNull(),
    integrationId: text("integration_id"),
    // Target brain for the job (principle: ingestion is per-brain). Null means
    // the handler resolves the user's default brain at run time.
    brainRef: text("brain_ref").references(() => goatBrains.id, { onDelete: "set null" }),
    kind: text("kind").$type<GoatBrainIngestJobKind>().notNull(),
    contentHash: text("content_hash").notNull(),
    status: text("status").$type<GoatBrainIngestJobStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull().defaultNow(),
    leaseId: text("lease_id"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Dedup is per target brain: one source item may fan out to several brains,
    // but repeated deliveries must not enqueue duplicate jobs for the same brain.
    sourceItemHashKindBrainIdx: uniqueIndex("goat_brain_ingest_jobs_item_hash_kind_brain_idx")
      .on(table.sourceItemId, table.contentHash, table.kind, table.brainRef)
      .where(sql`${table.brainRef} IS NOT NULL`),
    sourceItemHashKindNoBrainIdx: uniqueIndex("goat_brain_ingest_jobs_item_hash_kind_nobrain_idx")
      .on(table.sourceItemId, table.contentHash, table.kind)
      .where(sql`${table.brainRef} IS NULL`),
    statusNextRunIdx: index("goat_brain_ingest_jobs_status_next_run_idx").on(
      table.status,
      table.nextRunAt,
    ),
    leaseExpiresAtIdx: index("goat_brain_ingest_jobs_lease_expires_at_idx").on(
      table.leaseExpiresAt,
    ),
    userCreatedIdx: index("goat_brain_ingest_jobs_user_created_idx").on(
      table.userWorkosId,
      table.createdAt,
    ),
    sourceProviderCheck: check(
      "goat_brain_ingest_jobs_source_provider_check",
      sql`${table.sourceProvider} IN ('jamie', 'goat-chat', 'upload')`,
    ),
    kindCheck: check(
      "goat_brain_ingest_jobs_kind_check",
      sql`${table.kind} IN ('brain_source_item_ingest', 'brain_agent_ingest')`,
    ),
    statusCheck: check(
      "goat_brain_ingest_jobs_status_check",
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed')`,
    ),
  }),
);

export const goatTaskSchedules = goat.table(
  "task_schedules",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sourceDescription: text("source_description").notNull().default(""),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    prompt: text("prompt").notNull(),
    plannedHarnessSpec: jsonb("planned_harness_spec").$type<GoatHarnessSpec>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userDeletedCreatedIdx: index("goat_task_schedules_user_deleted_created_idx").on(
      table.userWorkosId,
      table.deletedAt,
      table.createdAt,
    ),
    dueIdx: index("goat_task_schedules_due_idx").on(
      table.enabled,
      table.deletedAt,
      table.nextRunAt,
    ),
    userNextRunIdx: index("goat_task_schedules_user_next_run_idx").on(
      table.userWorkosId,
      table.nextRunAt,
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
    scheduleId: text("schedule_id").references(() => goatTaskSchedules.id, {
      onDelete: "set null",
    }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    status: text("status").$type<GoatTaskStatus>().notNull().default("queued"),
    stage: text("stage").$type<GoatTaskStage>().notNull().default("queued"),
    result: text("result"),
    error: text("error"),
    harnessSpec: jsonb("harness_spec").$type<GoatHarnessSpec>().notNull().default(sql`'{}'::jsonb`),
    debugTrace: jsonb("debug_trace")
      .$type<GoatTaskDebugTrace>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    codexEngineSessionId: text("codex_engine_session_id"),
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
    scheduleIdx: index("goat_tasks_schedule_idx").on(table.scheduleId, table.scheduledFor),
    statusCheck: check(
      "goat_tasks_status_check",
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'canceled')`,
    ),
    stageCheck: check(
      "goat_tasks_stage_check",
      sql`${table.stage} IN ('queued', 'planning', 'sandboxing', 'running', 'completed', 'failed', 'canceled')`,
    ),
  }),
);

export const goatTaskScheduleRuns = goat.table(
  "task_schedule_runs",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => goatTaskSchedules.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    taskId: text("task_id").references(() => goatTasks.id, { onDelete: "set null" }),
    status: text("status").$type<GoatTaskScheduleRunStatus>().notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scheduleForIdx: uniqueIndex("goat_task_schedule_runs_schedule_for_idx").on(
      table.scheduleId,
      table.scheduledFor,
    ),
    userCreatedIdx: index("goat_task_schedule_runs_user_created_idx").on(
      table.userWorkosId,
      table.createdAt,
    ),
    taskIdx: index("goat_task_schedule_runs_task_idx").on(table.taskId),
    statusCheck: check(
      "goat_task_schedule_runs_status_check",
      sql`${table.status} IN ('pending', 'created', 'failed')`,
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

export const goatBrainToolRuns = goat.table(
  "brain_tool_runs",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    chatSessionId: text("chat_session_id").references(() => goatChatSessions.id, {
      onDelete: "set null",
    }),
    userMessageId: text("user_message_id").references(() => goatChatMessages.id, {
      onDelete: "set null",
    }),
    assistantMessageId: text("assistant_message_id").references(() => goatChatMessages.id, {
      onDelete: "set null",
    }),
    toolCallId: text("tool_call_id"),
    sourceRef: text("source_ref"),
    action: text("action"),
    ok: boolean("ok").notNull().default(false),
    exitCode: integer("exit_code"),
    durationMs: integer("duration_ms"),
    tracePath: text("trace_path"),
    trace: jsonb("trace").$type<GoatBrainToolRunTrace>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCreatedAtIdx: index("goat_brain_tool_runs_user_created_at_idx").on(
      table.userWorkosId,
      table.createdAt,
    ),
    chatSessionCreatedAtIdx: index("goat_brain_tool_runs_chat_session_created_at_idx").on(
      table.chatSessionId,
      table.createdAt,
    ),
    userMessageIdx: index("goat_brain_tool_runs_user_message_idx").on(table.userMessageId),
    toolCallIdx: index("goat_brain_tool_runs_tool_call_idx").on(table.toolCallId),
    sourceRefIdx: index("goat_brain_tool_runs_source_ref_idx").on(table.sourceRef),
  }),
);

export const goatCodexCredentials = goat.table(
  "codex_credentials",
  {
    userWorkosId: text("user_workos_id")
      .primaryKey()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    encryptedAuthJson: jsonb("encrypted_auth_json")
      .$type<GoatIntegrationCredentialEncryptedPayload>()
      .notNull(),
    encryptionKeyVersion: integer("encryption_key_version").notNull(),
    status: text("status").$type<GoatCodexCredentialStatus>().notNull().default("connected"),
    statusReason: text("status_reason"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("goat_codex_credentials_status_idx").on(table.status),
    statusCheck: check(
      "goat_codex_credentials_status_check",
      sql`${table.status} IN ('connected', 'needs_reauth')`,
    ),
  }),
);

export const goatCodexDeviceAuthFlows = goat.table(
  "codex_device_auth_flows",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    sandboxId: text("sandbox_id").notNull(),
    userCode: text("user_code"),
    verificationUri: text("verification_uri"),
    status: text("status").$type<GoatCodexDeviceAuthFlowStatus>().notNull().default("pending"),
    statusReason: text("status_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userStatusIdx: index("goat_codex_device_auth_flows_user_status_idx").on(
      table.userWorkosId,
      table.status,
    ),
    expiresAtIdx: index("goat_codex_device_auth_flows_expires_at_idx").on(table.expiresAt),
    statusCheck: check(
      "goat_codex_device_auth_flows_status_check",
      sql`${table.status} IN ('pending', 'code_ready', 'completed', 'failed', 'expired')`,
    ),
  }),
);

export const goatUsersRelations = relations(goatUsers, ({ many }) => ({
  workspaceMemberships: many(goatWorkspaceMembers),
  brainMemberships: many(goatBrainMembers),
  brainFolders: many(goatBrainFolders),
  brainDocuments: many(goatBrainDocuments),
  brainTimelineEntries: many(goatBrainTimelineEntries),
  brainEdges: many(goatBrainEdges),
  brainDocumentVersions: many(goatBrainDocumentVersions),
  brainToolRuns: many(goatBrainToolRuns),
  taskSchedules: many(goatTaskSchedules),
  taskScheduleRuns: many(goatTaskScheduleRuns),
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
  brainSourceItems: many(goatBrainSourceItems),
  brainIngestJobs: many(goatBrainIngestJobs),
  codexDeviceAuthFlows: many(goatCodexDeviceAuthFlows),
}));

export const goatWorkspacesRelations = relations(goatWorkspaces, ({ one, many }) => ({
  createdBy: one(goatUsers, {
    fields: [goatWorkspaces.createdByWorkosId],
    references: [goatUsers.workosUserId],
  }),
  members: many(goatWorkspaceMembers),
  brains: many(goatBrains),
}));

export const goatWorkspaceMembersRelations = relations(goatWorkspaceMembers, ({ one }) => ({
  workspace: one(goatWorkspaces, {
    fields: [goatWorkspaceMembers.workspaceId],
    references: [goatWorkspaces.id],
  }),
  user: one(goatUsers, {
    fields: [goatWorkspaceMembers.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
}));

export const goatBrainsRelations = relations(goatBrains, ({ one, many }) => ({
  workspace: one(goatWorkspaces, {
    fields: [goatBrains.workspaceId],
    references: [goatWorkspaces.id],
  }),
  createdBy: one(goatUsers, {
    fields: [goatBrains.createdByWorkosId],
    references: [goatUsers.workosUserId],
  }),
  members: many(goatBrainMembers),
  documents: many(goatBrainDocuments),
  folders: many(goatBrainFolders),
}));

export const goatBrainMembersRelations = relations(goatBrainMembers, ({ one }) => ({
  brain: one(goatBrains, {
    fields: [goatBrainMembers.brainId],
    references: [goatBrains.id],
  }),
  user: one(goatUsers, {
    fields: [goatBrainMembers.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
}));

export const goatBrainFoldersRelations = relations(goatBrainFolders, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatBrainFolders.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  brain: one(goatBrains, {
    fields: [goatBrainFolders.brainRef],
    references: [goatBrains.id],
  }),
}));

export const goatBrainDocumentsRelations = relations(goatBrainDocuments, ({ one, many }) => ({
  user: one(goatUsers, {
    fields: [goatBrainDocuments.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  brain: one(goatBrains, {
    fields: [goatBrainDocuments.brainRef],
    references: [goatBrains.id],
  }),
  timelineEntries: many(goatBrainTimelineEntries),
  edges: many(goatBrainEdges),
  versions: many(goatBrainDocumentVersions),
}));

export const goatBrainTimelineEntriesRelations = relations(goatBrainTimelineEntries, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatBrainTimelineEntries.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  document: one(goatBrainDocuments, {
    fields: [goatBrainTimelineEntries.documentId],
    references: [goatBrainDocuments.id],
  }),
}));

export const goatBrainEdgesRelations = relations(goatBrainEdges, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatBrainEdges.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  document: one(goatBrainDocuments, {
    fields: [goatBrainEdges.documentId],
    references: [goatBrainDocuments.id],
  }),
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

export const goatBrainToolRunsRelations = relations(goatBrainToolRuns, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatBrainToolRuns.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  chatSession: one(goatChatSessions, {
    fields: [goatBrainToolRuns.chatSessionId],
    references: [goatChatSessions.id],
  }),
  userMessage: one(goatChatMessages, {
    fields: [goatBrainToolRuns.userMessageId],
    references: [goatChatMessages.id],
    relationName: "goat_brain_tool_runs_user_message",
  }),
  assistantMessage: one(goatChatMessages, {
    fields: [goatBrainToolRuns.assistantMessageId],
    references: [goatChatMessages.id],
    relationName: "goat_brain_tool_runs_assistant_message",
  }),
}));

export const goatCodexCredentialsRelations = relations(goatCodexCredentials, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatCodexCredentials.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
}));

export const goatCodexDeviceAuthFlowsRelations = relations(goatCodexDeviceAuthFlows, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatCodexDeviceAuthFlows.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
}));

export const goatIntegrationsRelations = relations(goatIntegrations, ({ one, many }) => ({
  user: one(goatUsers, {
    fields: [goatIntegrations.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  credentials: many(goatIntegrationCredentials),
  resources: many(goatIntegrationResources),
  brainSourceItems: many(goatBrainSourceItems),
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

export const goatBrainSourceItemsRelations = relations(goatBrainSourceItems, ({ one, many }) => ({
  user: one(goatUsers, {
    fields: [goatBrainSourceItems.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  integration: one(goatIntegrations, {
    fields: [goatBrainSourceItems.integrationId],
    references: [goatIntegrations.id],
  }),
  ingestJobs: many(goatBrainIngestJobs),
}));

export const goatBrainIngestJobsRelations = relations(goatBrainIngestJobs, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatBrainIngestJobs.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  sourceItem: one(goatBrainSourceItems, {
    fields: [goatBrainIngestJobs.sourceItemId],
    references: [goatBrainSourceItems.id],
  }),
}));

export const goatTasksRelations = relations(goatTasks, ({ one, many }) => ({
  user: one(goatUsers, {
    fields: [goatTasks.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  schedule: one(goatTaskSchedules, {
    fields: [goatTasks.scheduleId],
    references: [goatTaskSchedules.id],
  }),
  taskMessages: many(goatTaskMessages),
  taskEvents: many(goatTaskEvents),
  modelUsage: many(goatTaskModelUsage),
  toolUsage: many(goatTaskToolUsage),
  sandboxUsage: many(goatTaskSandboxUsage),
  chatMessages: many(goatChatMessages),
  scheduleRuns: many(goatTaskScheduleRuns),
}));

export const goatTaskSchedulesRelations = relations(goatTaskSchedules, ({ one, many }) => ({
  user: one(goatUsers, {
    fields: [goatTaskSchedules.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  tasks: many(goatTasks),
  runs: many(goatTaskScheduleRuns),
}));

export const goatTaskScheduleRunsRelations = relations(goatTaskScheduleRuns, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatTaskScheduleRuns.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  schedule: one(goatTaskSchedules, {
    fields: [goatTaskScheduleRuns.scheduleId],
    references: [goatTaskSchedules.id],
  }),
  task: one(goatTasks, {
    fields: [goatTaskScheduleRuns.taskId],
    references: [goatTasks.id],
  }),
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
  brainToolRuns: many(goatBrainToolRuns),
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
export type GoatWorkspace = typeof goatWorkspaces.$inferSelect;
export type GoatWorkspaceMember = typeof goatWorkspaceMembers.$inferSelect;
export type GoatBrain = typeof goatBrains.$inferSelect;
export type GoatBrainMember = typeof goatBrainMembers.$inferSelect;
export type GoatBrainFolder = typeof goatBrainFolders.$inferSelect;
export type GoatBrainDocument = typeof goatBrainDocuments.$inferSelect;
export type GoatBrainTimelineEntryRecord = typeof goatBrainTimelineEntries.$inferSelect;
export type GoatBrainEdge = typeof goatBrainEdges.$inferSelect;
export type GoatBrainDocumentVersion = typeof goatBrainDocumentVersions.$inferSelect;
export type GoatBrainToolRun = typeof goatBrainToolRuns.$inferSelect;
export type GoatIntegration = typeof goatIntegrations.$inferSelect;
export type GoatIntegrationCredential = typeof goatIntegrationCredentials.$inferSelect;
export type GoatBrainSourceItem = typeof goatBrainSourceItems.$inferSelect;
export type GoatBrainIngestJob = typeof goatBrainIngestJobs.$inferSelect;
export type GoatCodexCredential = typeof goatCodexCredentials.$inferSelect;
export type GoatCodexDeviceAuthFlow = typeof goatCodexDeviceAuthFlows.$inferSelect;
export type GoatTaskSchedule = typeof goatTaskSchedules.$inferSelect;
export type GoatTaskScheduleRun = typeof goatTaskScheduleRuns.$inferSelect;
export type GoatTask = typeof goatTasks.$inferSelect;
export type GoatTaskMessage = typeof goatTaskMessages.$inferSelect;
export type GoatTaskEvent = typeof goatTaskEvents.$inferSelect;
export type GoatTaskModelUsage = typeof goatTaskModelUsage.$inferSelect;
export type GoatTaskToolUsage = typeof goatTaskToolUsage.$inferSelect;
export type GoatTaskSandboxUsage = typeof goatTaskSandboxUsage.$inferSelect;
export type GoatChatSession = typeof goatChatSessions.$inferSelect;
export type GoatChatMessage = typeof goatChatMessages.$inferSelect;
