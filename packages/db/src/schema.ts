import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export type TiptapDoc = {
  type: "doc";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content?: any[];
};

export type AgentToolId = "exa";
export type AgentModelId =
  | "openai/gpt-5.4-mini"
  | "openai/gpt-5.4"
  | "anthropic/claude-haiku-4.5"
  | "anthropic/claude-sonnet-4.6";

export type AgentConfigTool = {
  id: AgentToolId;
  type: "tool";
  label: string;
  description: string;
};

export type AgentConfig = {
  schemaVersion: "agent.v1";
  title: string;
  instructions: string;
  model: {
    provider: "vercel-ai-gateway";
    name: AgentModelId;
  };
  tools: AgentConfigTool[];
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
        sql`'{"schemaVersion":"agent.v1","title":"Untitled agent","instructions":"","model":{"provider":"vercel-ai-gateway","name":"openai/gpt-5.4-mini"},"tools":[]}'::jsonb`,
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
    modelProvider: text("model_provider").notNull().default("vercel-ai-gateway"),
    modelName: text("model_name").notNull().default("openai/gpt-5.4-mini"),
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
    statusIdx: index("agent_sessions_status_idx").on(table.status),
    visibleWorkspaceUserUpdatedIdx: index("agent_sessions_visible_workspace_user_updated_idx").on(
      table.workspaceId,
      table.userId,
      table.archivedAt,
      table.updatedAt,
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

export const agentSessionEvents = pgTable(
  "agent_session_events",
  {
    id: serial("id").primaryKey(),
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
    id: serial("id").primaryKey(),
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
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  createdBy: one(users, {
    fields: [workspaces.createdByUserId],
    references: [users.id],
  }),
  memberships: many(workspaceMemberships),
  agents: many(agents),
  agentSyncJobs: many(agentSyncJobs),
  agentSessions: many(agentSessions),
  onboardingResponses: many(onboardingResponses),
  repository: one(workspaceRepositories, {
    fields: [workspaces.id],
    references: [workspaceRepositories.workspaceId],
  }),
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
  messages: many(agentSessionMessages),
  events: many(agentSessionEvents),
  usage: many(agentSessionUsage),
}));

export const agentSessionMessagesRelations = relations(agentSessionMessages, ({ one, many }) => ({
  session: one(agentSessions, {
    fields: [agentSessionMessages.sessionId],
    references: [agentSessions.id],
  }),
  events: many(agentSessionEvents),
  usage: many(agentSessionUsage),
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
export type AgentSyncJob = typeof agentSyncJobs.$inferSelect;
export type AgentSession = typeof agentSessions.$inferSelect;
export type AgentSessionMessage = typeof agentSessionMessages.$inferSelect;
export type AgentSessionEvent = typeof agentSessionEvents.$inferSelect;
export type AgentSessionUsage = typeof agentSessionUsage.$inferSelect;
export type WorkspaceMembership = typeof workspaceMemberships.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type OnboardingResponse = typeof onboardingResponses.$inferSelect;
