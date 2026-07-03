import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { EncryptedPayload } from "@opencompany/crypto";
import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
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

export type GoatIntegrationProvider = "gmail" | "google_calendar";
export type GoatIntegrationStatus = "connected" | "needs_reauth" | "sync_failed" | "disconnected";
export type GoatIntegrationCredentialKind = "oauth_token";
export type GoatIntegrationCredentialEncryptedPayload = EncryptedPayload;

export type GoatHarnessToolId = "exa" | "gmail" | "google_calendar" | "goat_result";

export type GoatHarnessSpec = {
  prompt?: string;
  model?: string;
  tools?: GoatHarnessToolId[];
  resultMode?: "freeform";
};

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
  schemaVersion?: "goat.chat.debug.v1";
  model?: string;
  finishReason?: string;
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
      sql`${table.provider} IN ('gmail', 'google_calendar')`,
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
      sql`${table.provider} IN ('gmail', 'google_calendar')`,
    ),
    kindCheck: check(
      "goat_integration_credentials_kind_check",
      sql`${table.kind} IN ('oauth_token')`,
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
  tasks: many(goatTasks),
  chatSessions: many(goatChatSessions),
  integrations: many(goatIntegrations),
  integrationCredentials: many(goatIntegrationCredentials),
}));

export const goatIntegrationsRelations = relations(goatIntegrations, ({ one, many }) => ({
  user: one(goatUsers, {
    fields: [goatIntegrations.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  credentials: many(goatIntegrationCredentials),
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

export const goatTasksRelations = relations(goatTasks, ({ one, many }) => ({
  user: one(goatUsers, {
    fields: [goatTasks.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  chatMessages: many(goatChatMessages),
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
export type GoatIntegration = typeof goatIntegrations.$inferSelect;
export type GoatIntegrationCredential = typeof goatIntegrationCredentials.$inferSelect;
export type GoatTask = typeof goatTasks.$inferSelect;
export type GoatChatSession = typeof goatChatSessions.$inferSelect;
export type GoatChatMessage = typeof goatChatMessages.$inferSelect;
