import type { AgentConfig, TiptapDoc } from "@opencompany/agent-runtime/types";
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export type WorkspaceIntegrationConnectionStatus =
  | "connected"
  | "needs_reauth"
  | "sync_failed"
  | "disconnected";

export type WorkspaceIntegrationResourceStatus =
  | "available"
  | "permission_lost"
  | "archived"
  | "sync_failed";

export type WorkspaceIntegrationCredentialKind =
  | "oauth_token"
  | "api_key"
  | "webhook_secret"
  | (string & {});

export type WorkspaceMcpServerStatus = "configured" | "missing_credential" | "disabled" | "error";

export type WorkspaceMcpCredentialKind = "bearer_token" | (string & {});

export type WorkspaceIntegrationCredentialEncryptedPayload = {
  algorithm: "aes-256-gcm";
  iv: string;
  ciphertext: string;
  authTag: string;
};

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    workosUserId: text("workos_user_id").notNull(),
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workosUserIdIdx: uniqueIndex("users_workos_user_id_idx").on(table.workosUserId),
  }),
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    workosOrganizationId: text("workos_organization_id"),
    name: text("name").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    teamSize: text("team_size"),
    companyUrl: text("company_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workosOrganizationIdIdx: uniqueIndex("workspaces_workos_organization_id_idx").on(
      table.workosOrganizationId,
    ),
  }),
);

export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    membershipIdx: uniqueIndex("workspace_memberships_workspace_user_idx").on(
      table.workspaceId,
      table.userId,
    ),
  }),
);

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    path: text("path"),
    name: text("name").notNull().default("Untitled agent"),
    body: text("body").notNull().default(""),
    commitSha: text("commit_sha"),
    contentHash: text("content_hash"),
    version: integer("version").notNull().default(1),
    githubBlobSha: text("github_blob_sha"),
    githubCommitSha: text("github_commit_sha"),
    githubSyncedHash: text("github_synced_hash"),
    githubSyncedAt: timestamp("github_synced_at", { withTimezone: true }),
    githubSyncStatus: text("github_sync_status").notNull().default("pending"),
    githubSyncError: text("github_sync_error"),
    content: jsonb("content")
      .$type<TiptapDoc>()
      .notNull()
      .default(sql`'{"type":"doc","content":[]}'::jsonb`),
    config: jsonb("config")
      .$type<AgentConfig>()
      .notNull()
      .default(
        sql`'{"schemaVersion":"agent.v1","title":"Untitled agent","instructions":"","model":{"provider":"vercel-ai-gateway","name":"openai/gpt-5.4-mini"},"tools":[],"brain":[],"agents":[],"integrations":{"github":{"repositories":[]}},"triggers":[]}'::jsonb`,
      ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("agents_workspace_idx").on(table.workspaceId),
    workspacePathIdx: uniqueIndex("agents_workspace_path_idx").on(table.workspaceId, table.path),
  }),
);

export const agentSyncJobs = pgTable(
  "agent_sync_jobs",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    desiredHash: text("desired_hash").notNull(),
    desiredVersion: integer("desired_version").notNull(),
    previousPath: text("previous_path"),
    previousBlobSha: text("previous_blob_sha"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("agent_sync_jobs_workspace_idx").on(table.workspaceId),
    nextRunAtIdx: index("agent_sync_jobs_next_run_at_idx").on(table.nextRunAt),
  }),
);

export const brainFiles = pgTable(
  "brain_files",
  {
    id: serial("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull().default(""),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    githubBlobSha: text("github_blob_sha"),
    githubCommitSha: text("github_commit_sha"),
    githubSyncedHash: text("github_synced_hash"),
    githubSyncedAt: timestamp("github_synced_at", { withTimezone: true }),
    githubSyncStatus: text("github_sync_status").notNull().default("pending"),
    githubSyncError: text("github_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("brain_files_workspace_idx").on(table.workspaceId),
    workspacePathIdx: uniqueIndex("brain_files_workspace_path_idx").on(
      table.workspaceId,
      table.path,
    ),
  }),
);

export const brainSyncJobs = pgTable(
  "brain_sync_jobs",
  {
    id: serial("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    operation: text("operation").notNull().default("upsert"),
    desiredHash: text("desired_hash"),
    previousPath: text("previous_path"),
    previousBlobSha: text("previous_blob_sha"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("brain_sync_jobs_workspace_idx").on(table.workspaceId),
    workspacePathIdx: uniqueIndex("brain_sync_jobs_workspace_path_idx").on(
      table.workspaceId,
      table.path,
    ),
    nextRunAtIdx: index("brain_sync_jobs_next_run_at_idx").on(table.nextRunAt),
  }),
);

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("Untitled session"),
    status: text("status").notNull().default("created"),
    source: text("source").$type<"user" | "agent">().notNull().default("user"),
    modelProvider: text("model_provider").notNull().default("vercel-ai-gateway"),
    modelName: text("model_name").notNull().default("openai/gpt-5.4-mini"),
    parentSessionId: text("parent_session_id"),
    parentMessageId: text("parent_message_id"),
    parentToolCallId: text("parent_tool_call_id"),
    e2bSandboxId: text("e2b_sandbox_id"),
    workdir: text("workdir").notNull().default("/home/user/workspace"),
    runLeaseId: text("run_lease_id"),
    runLeaseOwner: text("run_lease_owner"),
    runLeaseMessageId: text("run_lease_message_id"),
    runLeaseExpiresAt: timestamp("run_lease_expires_at", { withTimezone: true }),
    runHeartbeatAt: timestamp("run_heartbeat_at", { withTimezone: true }),
    abortRequestedAt: timestamp("abort_requested_at", { withTimezone: true }),
    lastError: text("last_error"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    sandboxTerminatedAt: timestamp("sandbox_terminated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("agent_sessions_workspace_idx").on(table.workspaceId),
    agentIdx: index("agent_sessions_agent_idx").on(table.agentId),
    parentSessionIdx: index("agent_sessions_parent_session_idx").on(table.parentSessionId),
    parentSessionWorkspaceUserIdx: index("agent_sessions_parent_workspace_user_idx").on(
      table.parentSessionId,
      table.workspaceId,
      table.userId,
      table.archivedAt,
      table.updatedAt,
    ),
    sourceIdx: index("agent_sessions_source_idx").on(table.source),
    statusIdx: index("agent_sessions_status_idx").on(table.status),
    visibleWorkspaceUserUpdatedIdx: index("agent_sessions_visible_workspace_user_updated_idx").on(
      table.workspaceId,
      table.userId,
      table.archivedAt,
      table.updatedAt,
    ),
    visibleWorkspaceUserSourceUpdatedIdx: index(
      "agent_sessions_visible_workspace_user_source_updated_idx",
    ).on(table.workspaceId, table.userId, table.source, table.archivedAt, table.updatedAt),
    parentSessionFk: foreignKey({
      name: "agent_sessions_parent_session_fk",
      columns: [table.parentSessionId],
      foreignColumns: [table.id],
    }).onDelete("set null"),
    sourceCheck: check("agent_sessions_source_check", sql`${table.source} IN ('user', 'agent')`),
  }),
);

export const agentSessionBrainMounts = pgTable(
  "agent_session_brain_mounts",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requestedPath: text("requested_path").notNull(),
    path: text("path").notNull(),
    referenceType: text("reference_type").notNull().default("file"),
    baseHash: text("base_hash"),
    lastSyncedHash: text("last_synced_hash"),
    status: text("status").notNull().default("mounted"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index("agent_session_brain_mounts_session_idx").on(table.sessionId),
    workspaceIdx: index("agent_session_brain_mounts_workspace_idx").on(table.workspaceId),
    sessionPathIdx: uniqueIndex("agent_session_brain_mounts_session_path_idx").on(
      table.sessionId,
      table.path,
    ),
  }),
);

export const agentSessionMessages = pgTable(
  "agent_session_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    status: text("status").notNull().default("created"),
    content: text("content").notNull().default(""),
    internal: boolean("internal").notNull().default(false),
    modelMessage: jsonb("model_message").$type<Record<string, unknown>>(),
    toolName: text("tool_name"),
    toolCallId: text("tool_call_id"),
    responseToMessageId: text("response_to_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    sessionIdx: index("agent_session_messages_session_idx").on(table.sessionId),
    sessionCreatedAtIdx: index("agent_session_messages_session_created_at_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    responseToMessageIdx: uniqueIndex("agent_session_messages_response_to_message_idx").on(
      table.responseToMessageId,
    ),
  }),
);

export const agentSessionAfterSessionRuns = pgTable(
  "agent_session_after_session_runs",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    lastUserMessageId: text("last_user_message_id")
      .notNull()
      .references(() => agentSessionMessages.id, { onDelete: "cascade" }),
    agentVersion: integer("agent_version").notNull(),
    status: text("status").notNull().default("queued"),
    runLeaseId: text("run_lease_id"),
    skippedReason: text("skipped_reason"),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index("agent_session_after_session_runs_session_idx").on(table.sessionId),
    workspaceIdx: index("agent_session_after_session_runs_workspace_idx").on(table.workspaceId),
    idempotencyIdx: uniqueIndex("agent_session_after_session_runs_idempotency_idx").on(
      table.sessionId,
      table.lastUserMessageId,
      table.agentVersion,
    ),
  }),
);

export const agentSessionRunJobs = pgTable(
  "agent_session_run_jobs",
  {
    id: serial("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => agentSessionMessages.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    leaseId: text("lease_id"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyIdx: uniqueIndex("agent_session_run_jobs_idempotency_idx").on(table.idempotencyKey),
    sessionIdx: index("agent_session_run_jobs_session_idx").on(table.sessionId),
    statusNextRunAtIdx: index("agent_session_run_jobs_status_next_run_at_idx").on(
      table.status,
      table.nextRunAt,
    ),
    leaseExpiresAtIdx: index("agent_session_run_jobs_lease_expires_at_idx").on(
      table.leaseExpiresAt,
    ),
    kindCheck: check(
      "agent_session_run_jobs_kind_check",
      sql`${table.kind} IN ('start', 'message', 'title', 'after_session')`,
    ),
    statusCheck: check(
      "agent_session_run_jobs_status_check",
      sql`${table.status} IN ('pending', 'running', 'completed', 'failed')`,
    ),
  }),
);

export const agentSessionEvents = pgTable(
  "agent_session_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .default(sql`nextval('agent_session_events_id_seq'::regclass)`),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => agentSessionMessages.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index("agent_session_events_session_idx").on(table.sessionId),
    sessionEventIdx: index("agent_session_events_session_event_idx").on(table.sessionId, table.id),
  }),
);

export const agentSessionUsage = pgTable(
  "agent_session_usage",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .default(sql`nextval('agent_session_usage_id_seq'::regclass)`),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => agentSessionMessages.id, {
      onDelete: "set null",
    }),
    runLeaseId: text("run_lease_id"),
    stepIndex: integer("step_index").notNull(),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index("agent_session_usage_session_idx").on(table.sessionId),
    messageIdx: index("agent_session_usage_message_idx").on(table.messageId),
    sessionCreatedAtIdx: index("agent_session_usage_session_created_at_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    sessionMessageStepIdx: uniqueIndex("agent_session_usage_session_message_step_idx").on(
      table.sessionId,
      table.messageId,
      table.stepIndex,
    ),
  }),
);

export const agentSessionToolUsage = pgTable(
  "agent_session_tool_usage",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .default(sql`nextval('agent_session_tool_usage_id_seq'::regclass)`),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => agentSessionMessages.id, {
      onDelete: "set null",
    }),
    runLeaseId: text("run_lease_id"),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    provider: text("provider").notNull(),
    operation: text("operation").notNull(),
    providerRequestId: text("provider_request_id"),
    costUsdMicros: integer("cost_usd_micros").notNull().default(0),
    rawUsage: jsonb("raw_usage")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index("agent_session_tool_usage_session_idx").on(table.sessionId),
    messageIdx: index("agent_session_tool_usage_message_idx").on(table.messageId),
    sessionCreatedAtIdx: index("agent_session_tool_usage_session_created_at_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    toolCallIdx: index("agent_session_tool_usage_tool_call_idx").on(table.toolCallId),
    sessionToolCallOperationIdx: uniqueIndex(
      "agent_session_tool_usage_session_call_operation_idx",
    ).on(table.sessionId, table.messageId, table.toolCallId, table.provider, table.operation),
  }),
);

export const workspaceCreditBalances = pgTable("workspace_credit_balances", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  balanceCents: integer("balance_cents").notNull().default(0),
  balanceUsdMicros: bigint("balance_usd_micros", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const stripeCheckoutSessions = pgTable(
  "stripe_checkout_sessions",
  {
    id: text("id").primaryKey(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull().default("pending"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
  },
  (table) => ({
    stripeCheckoutSessionIdIdx: uniqueIndex(
      "stripe_checkout_sessions_stripe_checkout_session_id_idx",
    ).on(table.stripeCheckoutSessionId),
    workspaceIdx: index("stripe_checkout_sessions_workspace_idx").on(table.workspaceId),
  }),
);

export const creditCodes = pgTable(
  "credit_codes",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    amountCents: integer("amount_cents").notNull(),
    maxRedemptions: integer("max_redemptions"),
    redeemedCount: integer("redeemed_count").notNull().default(0),
    active: boolean("active").notNull().default(true),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    codeIdx: uniqueIndex("credit_codes_code_idx").on(table.code),
  }),
);

export const creditCodeRedemptions = pgTable(
  "credit_code_redemptions",
  {
    id: serial("id").primaryKey(),
    creditCodeId: text("credit_code_id")
      .notNull()
      .references(() => creditCodes.id, { onDelete: "restrict" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    amountCents: integer("amount_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    creditCodeWorkspaceIdx: uniqueIndex("credit_code_redemptions_code_workspace_idx").on(
      table.creditCodeId,
      table.workspaceId,
    ),
    workspaceIdx: index("credit_code_redemptions_workspace_idx").on(table.workspaceId),
  }),
);

export const workspaceCreditLedger = pgTable(
  "workspace_credit_ledger",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .default(sql`nextval('workspace_credit_ledger_id_seq'::regclass)`),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    amountCents: integer("amount_cents").notNull(),
    amountUsdMicros: bigint("amount_usd_micros", { mode: "number" }).notNull().default(0),
    source: text("source").notNull(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id").references(
      () => stripeCheckoutSessions.id,
      { onDelete: "set null" },
    ),
    creditCodeRedemptionId: integer("credit_code_redemption_id").references(
      () => creditCodeRedemptions.id,
      { onDelete: "set null" },
    ),
    sessionId: text("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
    messageId: text("message_id").references(() => agentSessionMessages.id, {
      onDelete: "set null",
    }),
    modelUsageId: bigint("model_usage_id", { mode: "number" }).references(
      () => agentSessionUsage.id,
      {
        onDelete: "set null",
      },
    ),
    toolUsageId: bigint("tool_usage_id", { mode: "number" }).references(
      () => agentSessionToolUsage.id,
      {
        onDelete: "set null",
      },
    ),
    providerCostUsdMicros: bigint("provider_cost_usd_micros", { mode: "number" })
      .notNull()
      .default(0),
    platformFeeUsdMicros: bigint("platform_fee_usd_micros", { mode: "number" })
      .notNull()
      .default(0),
    costBasis: jsonb("cost_basis")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceCreatedAtIdx: index("workspace_credit_ledger_workspace_created_at_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    stripeCheckoutSessionIdx: index("workspace_credit_ledger_stripe_checkout_session_idx").on(
      table.stripeCheckoutSessionId,
    ),
    creditCodeRedemptionIdx: index("workspace_credit_ledger_credit_code_redemption_idx").on(
      table.creditCodeRedemptionId,
    ),
    sessionIdx: index("workspace_credit_ledger_session_idx").on(table.sessionId),
    modelUsageIdx: uniqueIndex("workspace_credit_ledger_model_usage_idx")
      .on(table.modelUsageId)
      .where(sql`${table.modelUsageId} IS NOT NULL`),
    toolUsageIdx: uniqueIndex("workspace_credit_ledger_tool_usage_idx")
      .on(table.toolUsageId)
      .where(sql`${table.toolUsageId} IS NOT NULL`),
    signupBonusIdx: uniqueIndex("workspace_credit_ledger_signup_bonus_idx")
      .on(table.workspaceId)
      .where(sql`${table.source} = 'signup_bonus'`),
  }),
);

export const workspaceRepositories = pgTable(
  "workspace_repositories",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    githubRepoId: text("github_repo_id").notNull(),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    latestHeadSha: text("latest_head_sha"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    fullNameIdx: uniqueIndex("workspace_repositories_full_name_idx").on(table.fullName),
  }),
);

export const workspaceIntegrations = pgTable(
  "workspace_integrations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    connectionLabel: text("connection_label"),
    accountName: text("account_name"),
    accountEmail: text("account_email"),
    accountType: text("account_type"),
    connectedByUserId: text("connected_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: text("status")
      .$type<WorkspaceIntegrationConnectionStatus>()
      .notNull()
      .default("connected"),
    statusReason: text("status_reason"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceProviderIdx: index("workspace_integrations_workspace_provider_idx").on(
      table.workspaceId,
      table.provider,
    ),
    workspaceProviderExternalIdx: uniqueIndex(
      "workspace_integrations_workspace_provider_external_idx",
    ).on(table.workspaceId, table.provider, table.externalId),
    integrationWorkspaceProviderIdx: uniqueIndex(
      "workspace_integrations_id_workspace_provider_idx",
    ).on(table.id, table.workspaceId, table.provider),
    statusCheck: check(
      "workspace_integrations_status_check",
      sql`${table.status} IN ('connected', 'needs_reauth', 'sync_failed', 'disconnected')`,
    ),
  }),
);

export const workspaceIntegrationResources = pgTable(
  "workspace_integration_resources",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    integrationId: text("integration_id").notNull(),
    provider: text("provider").notNull(),
    resourceType: text("resource_type").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    displayName: text("display_name"),
    status: text("status")
      .$type<WorkspaceIntegrationResourceStatus>()
      .notNull()
      .default("available"),
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
    workspaceProviderTypeIdx: index(
      "workspace_integration_resources_workspace_provider_type_idx",
    ).on(table.workspaceId, table.provider, table.resourceType),
    integrationIdx: index("workspace_integration_resources_integration_idx").on(
      table.integrationId,
    ),
    integrationTypeExternalIdx: uniqueIndex(
      "workspace_integration_resources_integration_type_external_idx",
    ).on(table.integrationId, table.resourceType, table.externalId),
    integrationWorkspaceProviderFk: foreignKey({
      name: "workspace_integration_resources_integration_workspace_provider_fk",
      columns: [table.integrationId, table.workspaceId, table.provider],
      foreignColumns: [
        workspaceIntegrations.id,
        workspaceIntegrations.workspaceId,
        workspaceIntegrations.provider,
      ],
    }).onDelete("cascade"),
    statusCheck: check(
      "workspace_integration_resources_status_check",
      sql`${table.status} IN ('available', 'permission_lost', 'archived', 'sync_failed')`,
    ),
  }),
);

export const workspaceIntegrationCredentials = pgTable(
  "workspace_integration_credentials",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    integrationId: text("integration_id").notNull(),
    provider: text("provider").notNull(),
    kind: text("kind").$type<WorkspaceIntegrationCredentialKind>().notNull(),
    encryptedPayload: jsonb("encrypted_payload")
      .$type<WorkspaceIntegrationCredentialEncryptedPayload>()
      .notNull(),
    encryptionKeyVersion: integer("encryption_key_version").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceProviderIdx: index("workspace_integration_credentials_workspace_provider_idx").on(
      table.workspaceId,
      table.provider,
    ),
    integrationIdx: index("workspace_integration_credentials_integration_idx").on(
      table.integrationId,
    ),
    integrationKindIdx: uniqueIndex("workspace_integration_credentials_integration_kind_idx").on(
      table.integrationId,
      table.kind,
    ),
    integrationWorkspaceProviderFk: foreignKey({
      name: "workspace_integration_credentials_integration_workspace_provider_fk",
      columns: [table.integrationId, table.workspaceId, table.provider],
      foreignColumns: [
        workspaceIntegrations.id,
        workspaceIntegrations.workspaceId,
        workspaceIntegrations.provider,
      ],
    }).onDelete("cascade"),
  }),
);

export const workspaceExperiments = pgTable(
  "workspace_experiments",
  {
    id: serial("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceKeyIdx: uniqueIndex("workspace_experiments_workspace_key_idx").on(
      table.workspaceId,
      table.key,
    ),
  }),
);

export const workspaceMcpServers = pgTable(
  "workspace_mcp_servers",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    serverKey: text("server_key").notNull(),
    displayName: text("display_name").notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    status: text("status")
      .$type<WorkspaceMcpServerStatus>()
      .notNull()
      .default("missing_credential"),
    statusReason: text("status_reason"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceKeyIdx: uniqueIndex("workspace_mcp_servers_workspace_key_idx").on(
      table.workspaceId,
      table.serverKey,
    ),
    workspaceStatusIdx: index("workspace_mcp_servers_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
    workspaceServerFk: uniqueIndex("workspace_mcp_servers_id_workspace_idx").on(
      table.id,
      table.workspaceId,
    ),
    statusCheck: check(
      "workspace_mcp_servers_status_check",
      sql`${table.status} IN ('configured', 'missing_credential', 'disabled', 'error')`,
    ),
  }),
);

export const workspaceMcpCredentials = pgTable(
  "workspace_mcp_credentials",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    serverId: text("server_id").notNull(),
    kind: text("kind").$type<WorkspaceMcpCredentialKind>().notNull(),
    encryptedPayload: jsonb("encrypted_payload")
      .$type<WorkspaceIntegrationCredentialEncryptedPayload>()
      .notNull(),
    encryptionKeyVersion: integer("encryption_key_version").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("workspace_mcp_credentials_workspace_idx").on(table.workspaceId),
    serverIdx: index("workspace_mcp_credentials_server_idx").on(table.serverId),
    serverKindIdx: uniqueIndex("workspace_mcp_credentials_server_kind_idx").on(
      table.serverId,
      table.kind,
    ),
    serverWorkspaceFk: foreignKey({
      name: "workspace_mcp_credentials_server_workspace_fk",
      columns: [table.serverId, table.workspaceId],
      foreignColumns: [workspaceMcpServers.id, workspaceMcpServers.workspaceId],
    }).onDelete("cascade"),
  }),
);

export const agentSessionArtifacts = pgTable(
  "agent_session_artifacts",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => agentSessionMessages.id, {
      onDelete: "set null",
    }),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    kind: text("kind").notNull(),
    title: text("title"),
    url: text("url"),
    externalId: text("external_id"),
    repositoryFullName: text("repository_full_name"),
    branchName: text("branch_name"),
    diffStat: text("diff_stat"),
    diffPreview: text("diff_preview"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index("agent_session_artifacts_session_idx").on(table.sessionId),
    toolCallIdx: index("agent_session_artifacts_tool_call_idx").on(table.toolCallId),
  }),
);

export const onboardingResponses = pgTable(
  "onboarding_responses",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    heardFrom: text("heard_from").notNull(),
    heardFromDetail: text("heard_from_detail"),
    role: text("role").notNull(),
    agentExperience: text("agent_experience").notNull(),
    helpAreas: text("help_areas").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("onboarding_responses_workspace_idx").on(table.workspaceId),
  }),
);

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(workspaceMemberships),
  createdWorkspaces: many(workspaces),
  agentSessions: many(agentSessions),
  onboardingResponses: many(onboardingResponses),
  creditLedger: many(workspaceCreditLedger),
  stripeCheckoutSessions: many(stripeCheckoutSessions),
  creditCodeRedemptions: many(creditCodeRedemptions),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  createdBy: one(users, {
    fields: [workspaces.createdByUserId],
    references: [users.id],
  }),
  memberships: many(workspaceMemberships),
  agents: many(agents),
  agentSyncJobs: many(agentSyncJobs),
  brainFiles: many(brainFiles),
  brainSyncJobs: many(brainSyncJobs),
  agentSessions: many(agentSessions),
  onboardingResponses: many(onboardingResponses),
  creditBalance: one(workspaceCreditBalances, {
    fields: [workspaces.id],
    references: [workspaceCreditBalances.workspaceId],
  }),
  creditLedger: many(workspaceCreditLedger),
  stripeCheckoutSessions: many(stripeCheckoutSessions),
  creditCodeRedemptions: many(creditCodeRedemptions),
  repository: one(workspaceRepositories, {
    fields: [workspaces.id],
    references: [workspaceRepositories.workspaceId],
  }),
  integrations: many(workspaceIntegrations),
  integrationResources: many(workspaceIntegrationResources),
  integrationCredentials: many(workspaceIntegrationCredentials),
  experiments: many(workspaceExperiments),
  mcpServers: many(workspaceMcpServers),
  mcpCredentials: many(workspaceMcpCredentials),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [agents.workspaceId],
    references: [workspaces.id],
  }),
  syncJob: one(agentSyncJobs, {
    fields: [agents.id],
    references: [agentSyncJobs.agentId],
  }),
  sessions: many(agentSessions),
}));

export const brainFilesRelations = relations(brainFiles, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [brainFiles.workspaceId],
    references: [workspaces.id],
  }),
}));

export const brainSyncJobsRelations = relations(brainSyncJobs, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [brainSyncJobs.workspaceId],
    references: [workspaces.id],
  }),
}));

export const agentSessionsRelations = relations(agentSessions, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [agentSessions.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [agentSessions.userId],
    references: [users.id],
  }),
  agent: one(agents, {
    fields: [agentSessions.agentId],
    references: [agents.id],
  }),
  parentSession: one(agentSessions, {
    fields: [agentSessions.parentSessionId],
    references: [agentSessions.id],
    relationName: "delegated_session_parent",
  }),
  childSessions: many(agentSessions, { relationName: "delegated_session_parent" }),
  messages: many(agentSessionMessages),
  events: many(agentSessionEvents),
  usage: many(agentSessionUsage),
  toolUsage: many(agentSessionToolUsage),
  brainMounts: many(agentSessionBrainMounts),
  artifacts: many(agentSessionArtifacts),
  runJobs: many(agentSessionRunJobs),
}));

export const agentSessionBrainMountsRelations = relations(agentSessionBrainMounts, ({ one }) => ({
  session: one(agentSessions, {
    fields: [agentSessionBrainMounts.sessionId],
    references: [agentSessions.id],
  }),
  workspace: one(workspaces, {
    fields: [agentSessionBrainMounts.workspaceId],
    references: [workspaces.id],
  }),
}));

export const agentSessionMessagesRelations = relations(agentSessionMessages, ({ one, many }) => ({
  session: one(agentSessions, {
    fields: [agentSessionMessages.sessionId],
    references: [agentSessions.id],
  }),
  events: many(agentSessionEvents),
  usage: many(agentSessionUsage),
  toolUsage: many(agentSessionToolUsage),
}));

export const agentSessionEventsRelations = relations(agentSessionEvents, ({ one }) => ({
  session: one(agentSessions, {
    fields: [agentSessionEvents.sessionId],
    references: [agentSessions.id],
  }),
  message: one(agentSessionMessages, {
    fields: [agentSessionEvents.messageId],
    references: [agentSessionMessages.id],
  }),
}));

export const agentSessionUsageRelations = relations(agentSessionUsage, ({ one }) => ({
  session: one(agentSessions, {
    fields: [agentSessionUsage.sessionId],
    references: [agentSessions.id],
  }),
  message: one(agentSessionMessages, {
    fields: [agentSessionUsage.messageId],
    references: [agentSessionMessages.id],
  }),
}));

export const agentSessionToolUsageRelations = relations(agentSessionToolUsage, ({ one }) => ({
  session: one(agentSessions, {
    fields: [agentSessionToolUsage.sessionId],
    references: [agentSessions.id],
  }),
  message: one(agentSessionMessages, {
    fields: [agentSessionToolUsage.messageId],
    references: [agentSessionMessages.id],
  }),
}));

export const agentSessionRunJobsRelations = relations(agentSessionRunJobs, ({ one }) => ({
  session: one(agentSessions, {
    fields: [agentSessionRunJobs.sessionId],
    references: [agentSessions.id],
  }),
  message: one(agentSessionMessages, {
    fields: [agentSessionRunJobs.messageId],
    references: [agentSessionMessages.id],
  }),
}));

export const workspaceCreditBalancesRelations = relations(workspaceCreditBalances, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceCreditBalances.workspaceId],
    references: [workspaces.id],
  }),
}));

export const stripeCheckoutSessionsRelations = relations(stripeCheckoutSessions, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [stripeCheckoutSessions.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [stripeCheckoutSessions.userId],
    references: [users.id],
  }),
}));

export const creditCodesRelations = relations(creditCodes, ({ many }) => ({
  redemptions: many(creditCodeRedemptions),
}));

export const creditCodeRedemptionsRelations = relations(creditCodeRedemptions, ({ one, many }) => ({
  creditCode: one(creditCodes, {
    fields: [creditCodeRedemptions.creditCodeId],
    references: [creditCodes.id],
  }),
  workspace: one(workspaces, {
    fields: [creditCodeRedemptions.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [creditCodeRedemptions.userId],
    references: [users.id],
  }),
  ledgerEntries: many(workspaceCreditLedger),
}));

export const workspaceCreditLedgerRelations = relations(workspaceCreditLedger, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceCreditLedger.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [workspaceCreditLedger.userId],
    references: [users.id],
  }),
  stripeCheckoutSession: one(stripeCheckoutSessions, {
    fields: [workspaceCreditLedger.stripeCheckoutSessionId],
    references: [stripeCheckoutSessions.id],
  }),
  creditCodeRedemption: one(creditCodeRedemptions, {
    fields: [workspaceCreditLedger.creditCodeRedemptionId],
    references: [creditCodeRedemptions.id],
  }),
  session: one(agentSessions, {
    fields: [workspaceCreditLedger.sessionId],
    references: [agentSessions.id],
  }),
  message: one(agentSessionMessages, {
    fields: [workspaceCreditLedger.messageId],
    references: [agentSessionMessages.id],
  }),
  modelUsage: one(agentSessionUsage, {
    fields: [workspaceCreditLedger.modelUsageId],
    references: [agentSessionUsage.id],
  }),
  toolUsage: one(agentSessionToolUsage, {
    fields: [workspaceCreditLedger.toolUsageId],
    references: [agentSessionToolUsage.id],
  }),
}));

export const agentSyncJobsRelations = relations(agentSyncJobs, ({ one }) => ({
  agent: one(agents, {
    fields: [agentSyncJobs.agentId],
    references: [agents.id],
  }),
  workspace: one(workspaces, {
    fields: [agentSyncJobs.workspaceId],
    references: [workspaces.id],
  }),
}));

export const workspaceRepositoriesRelations = relations(workspaceRepositories, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceRepositories.workspaceId],
    references: [workspaces.id],
  }),
}));

export const workspaceIntegrationsRelations = relations(workspaceIntegrations, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [workspaceIntegrations.workspaceId],
    references: [workspaces.id],
  }),
  connectedByUser: one(users, {
    fields: [workspaceIntegrations.connectedByUserId],
    references: [users.id],
  }),
  resources: many(workspaceIntegrationResources),
  credentials: many(workspaceIntegrationCredentials),
}));

export const workspaceIntegrationResourcesRelations = relations(
  workspaceIntegrationResources,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [workspaceIntegrationResources.workspaceId],
      references: [workspaces.id],
    }),
    integration: one(workspaceIntegrations, {
      fields: [workspaceIntegrationResources.integrationId],
      references: [workspaceIntegrations.id],
    }),
  }),
);

export const workspaceIntegrationCredentialsRelations = relations(
  workspaceIntegrationCredentials,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [workspaceIntegrationCredentials.workspaceId],
      references: [workspaces.id],
    }),
    integration: one(workspaceIntegrations, {
      fields: [workspaceIntegrationCredentials.integrationId],
      references: [workspaceIntegrations.id],
    }),
  }),
);

export const workspaceExperimentsRelations = relations(workspaceExperiments, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceExperiments.workspaceId],
    references: [workspaces.id],
  }),
}));

export const workspaceMcpServersRelations = relations(workspaceMcpServers, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMcpServers.workspaceId],
    references: [workspaces.id],
  }),
  credentials: many(workspaceMcpCredentials),
}));

export const workspaceMcpCredentialsRelations = relations(workspaceMcpCredentials, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMcpCredentials.workspaceId],
    references: [workspaces.id],
  }),
  server: one(workspaceMcpServers, {
    fields: [workspaceMcpCredentials.serverId, workspaceMcpCredentials.workspaceId],
    references: [workspaceMcpServers.id, workspaceMcpServers.workspaceId],
  }),
}));

export const agentSessionArtifactsRelations = relations(agentSessionArtifacts, ({ one }) => ({
  session: one(agentSessions, {
    fields: [agentSessionArtifacts.sessionId],
    references: [agentSessions.id],
  }),
  message: one(agentSessionMessages, {
    fields: [agentSessionArtifacts.messageId],
    references: [agentSessionMessages.id],
  }),
}));

export const workspaceMembershipsRelations = relations(workspaceMemberships, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMemberships.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [workspaceMemberships.userId],
    references: [users.id],
  }),
}));

export const onboardingResponsesRelations = relations(onboardingResponses, ({ one }) => ({
  user: one(users, {
    fields: [onboardingResponses.userId],
    references: [users.id],
  }),
  workspace: one(workspaces, {
    fields: [onboardingResponses.workspaceId],
    references: [workspaces.id],
  }),
}));

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceRepository = typeof workspaceRepositories.$inferSelect;
export type WorkspaceIntegration = typeof workspaceIntegrations.$inferSelect;
export type WorkspaceIntegrationResource = typeof workspaceIntegrationResources.$inferSelect;
export type WorkspaceIntegrationCredential = typeof workspaceIntegrationCredentials.$inferSelect;
export type WorkspaceCreditBalance = typeof workspaceCreditBalances.$inferSelect;
export type WorkspaceCreditLedgerEntry = typeof workspaceCreditLedger.$inferSelect;
export type StripeCheckoutSession = typeof stripeCheckoutSessions.$inferSelect;
export type CreditCode = typeof creditCodes.$inferSelect;
export type CreditCodeRedemption = typeof creditCodeRedemptions.$inferSelect;
export type AgentSyncJob = typeof agentSyncJobs.$inferSelect;
export type BrainFile = typeof brainFiles.$inferSelect;
export type BrainSyncJob = typeof brainSyncJobs.$inferSelect;
export type AgentSession = typeof agentSessions.$inferSelect;
export type AgentSessionBrainMount = typeof agentSessionBrainMounts.$inferSelect;
export type AgentSessionMessage = typeof agentSessionMessages.$inferSelect;
export type AgentSessionEvent = typeof agentSessionEvents.$inferSelect;
export type AgentSessionUsage = typeof agentSessionUsage.$inferSelect;
export type AgentSessionArtifact = typeof agentSessionArtifacts.$inferSelect;
export type AgentSessionToolUsage = typeof agentSessionToolUsage.$inferSelect;
export type AgentSessionRunJob = typeof agentSessionRunJobs.$inferSelect;
export type WorkspaceMembership = typeof workspaceMemberships.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type OnboardingResponse = typeof onboardingResponses.$inferSelect;
