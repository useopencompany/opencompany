import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
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

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdByUserId: text("created_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  teamSize: text("team_size"),
  companyUrl: text("company_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("owner"),
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
    workspacePathIdx: uniqueIndex("agents_workspace_path_idx").on(
      table.workspaceId,
      table.path,
    ),
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
    fullNameIdx: uniqueIndex("workspace_repositories_full_name_idx").on(
      table.fullName,
    ),
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
  onboardingResponses: many(onboardingResponses),
  repository: one(workspaceRepositories, {
    fields: [workspaces.id],
    references: [workspaceRepositories.workspaceId],
  }),
}));

export const agentsRelations = relations(agents, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [agents.workspaceId],
    references: [workspaces.id],
  }),
  syncJob: one(agentSyncJobs, {
    fields: [agents.id],
    references: [agentSyncJobs.agentId],
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

export const workspaceRepositoriesRelations = relations(
  workspaceRepositories,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [workspaceRepositories.workspaceId],
      references: [workspaces.id],
    }),
  }),
);

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
export type WorkspaceMembership = typeof workspaceMemberships.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type OnboardingResponse = typeof onboardingResponses.$inferSelect;
