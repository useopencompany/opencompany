import type {
  AgentConfig,
  AgentEngine,
  AgentSessionQuestionAnswer,
  AgentSessionQuestionPrompt,
  AgentSkillFile,
  CodexReasoningEffort,
  TiptapDoc,
} from "@opencompany/agent-runtime/types";
import type { EncryptedPayload } from "@opencompany/crypto";
import { relations, type SQL, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
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

export type WorkspaceCodexCredentialStatus = "connected" | "needs_reauth";

export type ConnectorOrganizationRole = "owner" | "member";

export type ConnectorMcpServerStatus = "configured" | "missing_credential" | "disabled" | "error";

export type ConnectorMcpCredentialKind = "oauth" | (string & {});

export type ConnectorPermissionScope = "linear.issues.read" | "linear.issues.write";

export type WorkspaceCodexDeviceAuthFlowStatus =
  | "pending"
  | "code_ready"
  | "completed"
  | "failed"
  | "expired";

// Canonical encrypted-payload shape lives in @opencompany/crypto; aliased here so the
// jsonb column annotations and existing importers keep their familiar name.
export type WorkspaceIntegrationCredentialEncryptedPayload = EncryptedPayload;

// Postgres `bytea` for small binary blobs (user-uploaded avatars, PRO-47).
// Drizzle has no built-in bytea helper; values round-trip as Node Buffers.
// The neon-http driver returns bytea as a hex string ("\\x...") rather than a
// Buffer, so normalize defensively on read.
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
  fromDriver(value: unknown): Buffer {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof value === "string") {
      const hex = value.startsWith("\\x") ? value.slice(2) : value;
      return Buffer.from(hex, "hex");
    }
    throw new Error(`Unexpected bytea value from driver (${typeof value}).`);
  },
});

// Postgres full-text search vector. Only ever written by the database (a STORED
// generated column), so no from/toDriver mapping is needed — the app reads `content`,
// never the tsvector itself.
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const connectorSchema = pgSchema("connector");

export const connectorUsers = connectorSchema.table(
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
    workosUserIdIdx: uniqueIndex("connector_users_workos_user_id_idx").on(table.workosUserId),
  }),
);

export const connectorOrganizations = connectorSchema.table(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => connectorUsers.id, { onDelete: "restrict" }),
    setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugIdx: uniqueIndex("connector_organizations_slug_idx").on(table.slug),
  }),
);

export const connectorOrganizationMemberships = connectorSchema.table(
  "organization_memberships",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => connectorOrganizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => connectorUsers.id, { onDelete: "cascade" }),
    role: text("role").$type<ConnectorOrganizationRole>().notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    membershipIdx: uniqueIndex("connector_organization_memberships_org_user_idx").on(
      table.organizationId,
      table.userId,
    ),
    roleCheck: check(
      "connector_organization_memberships_role_check",
      sql`${table.role} IN ('owner', 'member')`,
    ),
  }),
);

export const connectorMcpServers = connectorSchema.table(
  "mcp_servers",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => connectorOrganizations.id, { onDelete: "cascade" }),
    serverKey: text("server_key").notNull(),
    displayName: text("display_name").notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    status: text("status")
      .$type<ConnectorMcpServerStatus>()
      .notNull()
      .default("missing_credential"),
    statusReason: text("status_reason"),
    connectedByUserId: text("connected_by_user_id").references(() => connectorUsers.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organizationKeyIdx: uniqueIndex("connector_mcp_servers_org_key_idx").on(
      table.organizationId,
      table.serverKey,
    ),
    organizationStatusIdx: index("connector_mcp_servers_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    serverOrganizationIdx: uniqueIndex("connector_mcp_servers_id_org_idx").on(
      table.id,
      table.organizationId,
    ),
    statusCheck: check(
      "connector_mcp_servers_status_check",
      sql`${table.status} IN ('configured', 'missing_credential', 'disabled', 'error')`,
    ),
  }),
);

export const connectorMcpCredentials = connectorSchema.table(
  "mcp_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => connectorOrganizations.id, { onDelete: "cascade" }),
    serverId: text("server_id").notNull(),
    kind: text("kind").$type<ConnectorMcpCredentialKind>().notNull(),
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
    organizationIdx: index("connector_mcp_credentials_org_idx").on(table.organizationId),
    serverIdx: index("connector_mcp_credentials_server_idx").on(table.serverId),
    serverKindIdx: uniqueIndex("connector_mcp_credentials_server_kind_idx").on(
      table.serverId,
      table.kind,
    ),
    serverOrganizationFk: foreignKey({
      name: "connector_mcp_credentials_server_org_fk",
      columns: [table.serverId, table.organizationId],
      foreignColumns: [connectorMcpServers.id, connectorMcpServers.organizationId],
    }).onDelete("cascade"),
  }),
);

export const connectorPermissionGrants = connectorSchema.table(
  "permission_grants",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => connectorOrganizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    scope: text("scope").$type<ConnectorPermissionScope>().notNull(),
    granted: boolean("granted").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organizationProviderScopeIdx: uniqueIndex(
      "connector_permission_grants_org_provider_scope_idx",
    ).on(table.organizationId, table.provider, table.scope),
    scopeCheck: check(
      "connector_permission_grants_scope_check",
      sql`${table.scope} IN ('linear.issues.read', 'linear.issues.write')`,
    ),
  }),
);

export const connectorWaitlistSignups = connectorSchema.table(
  "waitlist_signups",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailIdx: uniqueIndex("connector_waitlist_signups_email_idx").on(table.email),
  }),
);

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    workosUserId: text("workos_user_id").notNull(),
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    avatarUrl: text("avatar_url"),
    // Per-user product-surface switch for the personal-agent-first pivot. When true the user's
    // primary surface is the personal agent (root → /personal); when false they get the legacy
    // company/workspace surface (root → /company). Defaults true in this phase. Keeps the company
    // model fully alive per-user so we can flip individuals rather than the whole deployment.
    personalFirst: boolean("personal_first").notNull().default(true),
    // Per-user "Pro mode" switch for the personal-agent surface. When true the user sees advanced
    // surfaces (e.g. the read-only agent Memory inspector) that are hidden by default. Off for
    // everyone until they opt in from personal Settings. Kept on `users` (a tiny boolean) so the
    // auth hot path loads it for free, mirroring `personalFirst`.
    proMode: boolean("pro_mode").notNull().default(false),
    // Per-user opt-in to the legacy company/workspace surface for personal-first users. When true
    // the /personal sidebar shows the Personal/Company space switcher again so existing users can
    // reach /company. Off for everyone until they opt in from personal Settings. Kept on `users`
    // (a tiny boolean) so the auth hot path loads it for free, mirroring `proMode`.
    companySurfaceEnabled: boolean("company_surface_enabled").notNull().default(false),
    // Per-user feature flag for the Codex runtime. When true the agent editor shows the engine
    // selector so an agent can be switched from the default OpenCompany runtime to Codex; off for
    // everyone until they opt in from Settings → Feature flags. Kept on `users` (a tiny boolean)
    // so the auth hot path loads it for free, mirroring `proMode`/`companySurfaceEnabled`.
    codexEngineEnabled: boolean("codex_engine_enabled").notNull().default(false),
    // IANA timezone used by user-owned scheduled routines. Individual personal routines derive
    // from this setting so users manage their local time in one place.
    timezone: text("timezone").notNull().default("UTC"),
    // Where `timezone` came from. `unset` means we have not initialized it from the browser yet;
    // `browser` means the app can keep it in sync with browser timezone changes; `manual` means
    // the user chose a fixed timezone in Settings and automatic detection must not override it.
    timezoneSource: text("timezone_source").notNull().default("unset"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workosUserIdIdx: uniqueIndex("users_workos_user_id_idx").on(table.workosUserId),
  }),
);

// User-uploaded avatar (PRO-47). Kept in its own table so the auth hot path
// (`loadCurrentWorkspaceContextReadOnly` selects all `users` columns on every request)
// never drags the image bytes. When a row exists it overrides the WorkOS avatarUrl.
export const userAvatars = pgTable("user_avatars", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  blob: bytea("blob").notNull(),
  mime: text("mime").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    // null = workspace-wide agent (existing behaviour, incl. the onboarding "leo").
    // set = private agent owned by this user (e.g. the /personal experiment agent).
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    // Marks a user's primary personal agent. Unique per (workspace, user) — see
    // agentsWorkspaceUserDefaultIdx below.
    isDefault: boolean("is_default").notNull().default(false),
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
        sql`'{"schemaVersion":"agent.v1","title":"Untitled agent","instructions":"","engine":"opencompany","model":{"provider":"vercel-ai-gateway","name":"openai/gpt-5.4-mini"},"tools":[],"brain":[],"agents":[],"integrations":{"github":{"repositories":[]}},"triggers":[]}'::jsonb`,
      ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("agents_workspace_idx").on(table.workspaceId),
    workspacePathIdx: uniqueIndex("agents_workspace_path_idx").on(table.workspaceId, table.path),
    // At most one default agent per user per workspace. Scoped by workspace (not
    // user alone) because a user can belong to multiple workspaces.
    workspaceUserDefaultIdx: uniqueIndex("agents_workspace_user_default_idx")
      .on(table.workspaceId, table.userId)
      .where(sql`${table.isDefault} = true`),
  }),
);

// External skills snapshotted from a web source (GitHub / skills.sh), reusable across all
// agents in a workspace. A refreshable cache: re-resolved to branch HEAD on each run, so
// `resolvedCommit` / `integrity` / `files` move over time. One row per (source, ref, skill);
// `integrity` lets the runner skip rewrites when content is unchanged.
export const workspaceSkillSnapshots = pgTable(
  "workspace_skill_snapshots",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    // Optional slash-command slug declared in SKILL.md frontmatter; surfaced in the composer
    // as `/<command>` for agents that enable this skill. Null when the skill declares none.
    command: text("command"),
    sourceType: text("source_type").notNull().default("github"),
    sourceUrl: text("source_url").notNull(),
    requestedRef: text("requested_ref").notNull(),
    skillPath: text("skill_path").notNull().default(""),
    resolvedCommit: text("resolved_commit").notNull(),
    integrity: text("integrity").notNull(),
    files: jsonb("files").$type<AgentSkillFile[]>().notNull(),
    fileCount: integer("file_count").notNull(),
    totalBytes: integer("total_bytes").notNull(),
    lastResolvedAt: timestamp("last_resolved_at", { withTimezone: true }).notNull().defaultNow(),
    schemaVersion: integer("schema_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceIdx: uniqueIndex("workspace_skill_snapshots_source_idx").on(
      table.workspaceId,
      table.sourceUrl,
      table.requestedRef,
      table.skillPath,
    ),
    skillIdIdx: index("workspace_skill_snapshots_skill_id_idx").on(
      table.workspaceId,
      table.skillId,
    ),
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

export const agentFiles = pgTable(
  "agent_files",
  {
    id: serial("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
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
    workspaceIdx: index("agent_files_workspace_idx").on(table.workspaceId),
    agentIdx: index("agent_files_agent_idx").on(table.agentId),
    workspacePathIdx: uniqueIndex("agent_files_workspace_path_idx").on(
      table.workspaceId,
      table.path,
    ),
  }),
);

// Append-only version history for brain knowledge files. Before the runner
// overwrites or deletes a personal-brain (agentFiles) or company-brain
// (brainFiles) file, the prior content is captured here so any bad turn can be
// rolled back ("step back a turn"). This is the durability floor for PRO-244:
// no user knowledge is silently lost, because the displaced bytes always land
// in a version row first. Deliberately NOT FK-linked to agents/sessions — a
// recreated agent or pruned session must not cascade-delete the backups.
export const brainFileVersions = pgTable(
  "brain_file_versions",
  {
    id: serial("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // "personal" -> agentFiles/personal-brain, "company" -> brainFiles/brain.
    scope: text("scope").notNull(),
    // Set for personal scope (owning agent); null for company brain.
    agentId: text("agent_id"),
    // Canonical repo path of the file whose prior content this row preserves.
    path: text("path").notNull(),
    content: text("content").notNull().default(""),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    // What displaced this content: "overwrite" | "delete".
    operation: text("operation").notNull(),
    // Session/turn that displaced it — the grouping key for "step back a turn".
    sessionId: text("session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lookupIdx: index("brain_file_versions_lookup_idx").on(
      table.workspaceId,
      table.scope,
      table.path,
      table.createdAt,
    ),
    sessionIdx: index("brain_file_versions_session_idx").on(table.workspaceId, table.sessionId),
  }),
);

// Unified, workspace-scoped projection outbox. Producers (web brain/agent
// edits, runner writeback, agent self-edit) write canonical content to their
// own tables and enqueue one row here per dirty repo path. A single projector
// (`projectWorkspaceToGitHub`) drains all due rows for a workspace and commits
// them to GitHub in one Git Data API commit. This is the consolidation target
// that replaces brain_sync_jobs / agent_sync_jobs / agent_file_sync_jobs.
//
// Those three legacy tables are no longer modelled here, but migration 0038
// only backfills their in-flight rows into this outbox — it deliberately does
// NOT drop them. The DROP is deferred to a follow-up migration that should run
// only after this projector-only release has fully deployed, so the previous
// web/runner binaries (which still write those tables) keep working during the
// rollout window.
//
// `sourceKind` + `sourceRef` tell the projector where to read desired content:
//   - "brain"      -> brainFiles row keyed by (workspaceId, logical brain path)
//   - "agent_file" -> agentFiles row keyed by (workspaceId, repoPath)
//   - "agent"      -> agents row keyed by sourceRef (agentId); re-serialized
// `repoPath` is always the full repo-relative path (e.g. "brain/spec.md",
// "agents/leo.agent", "agents/leo/user.md").
export const workspaceSyncJobs = pgTable(
  "workspace_sync_jobs",
  {
    id: serial("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repoPath: text("repo_path").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceRef: text("source_ref"),
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
    workspaceIdx: index("workspace_sync_jobs_workspace_idx").on(table.workspaceId),
    workspaceRepoPathIdx: uniqueIndex("workspace_sync_jobs_workspace_repo_path_idx").on(
      table.workspaceId,
      table.repoPath,
    ),
    nextRunAtIdx: index("workspace_sync_jobs_next_run_at_idx").on(table.nextRunAt),
    sourceKindCheck: check(
      "workspace_sync_jobs_source_kind_check",
      sql`${table.sourceKind} IN ('brain', 'agent_file', 'agent')`,
    ),
    operationCheck: check(
      "workspace_sync_jobs_operation_check",
      sql`${table.operation} IN ('upsert', 'delete')`,
    ),
    statusCheck: check(
      "workspace_sync_jobs_status_check",
      sql`${table.status} IN ('pending', 'syncing', 'failed')`,
    ),
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
    engine: text("engine").$type<AgentEngine>().notNull().default("opencompany"),
    engineSessionId: text("engine_session_id"),
    source: text("source")
      .$type<"user" | "agent" | "memory" | "whatsapp">()
      .notNull()
      .default("user"),
    modelProvider: text("model_provider").notNull().default("vercel-ai-gateway"),
    modelName: text("model_name").notNull().default("openai/gpt-5.4-mini"),
    codexReasoningEffort: text("codex_reasoning_effort")
      .$type<CodexReasoningEffort>()
      .notNull()
      .default("high"),
    codexPlanModeEnabled: boolean("codex_plan_mode_enabled").notNull().default(false),
    codexPlanModeReasoningEffort: text("codex_plan_mode_reasoning_effort")
      .$type<CodexReasoningEffort>()
      .notNull()
      .default("high"),
    parentSessionId: text("parent_session_id"),
    parentMessageId: text("parent_message_id"),
    parentToolCallId: text("parent_tool_call_id"),
    // Delegation nesting depth: 0 for a user/scheduled/memory session, parent.delegationDepth + 1
    // for a delegated (source="agent") child. Denormalized at child-create so a detached child
    // run (its own job, no in-process caller) can enforce MAX_AGENT_DELEGATION_DEPTH without
    // walking the parent chain on every spawn.
    delegationDepth: integer("delegation_depth").notNull().default(0),
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
    // When the agent last yielded control back to the user (turn completed/failed or
    // parked for approval/input) — set at the run-lease finish chokepoint, NOT on abort.
    // Compared against lastSeenAt to derive the sidebar's "unseen" blue dot.
    lastTurnFinishedAt: timestamp("last_turn_finished_at", { withTimezone: true }),
    // When the current user last viewed this session. Written by the web (markSessionSeen);
    // deliberately does NOT touch updatedAt so viewing never reshuffles sidebar recency.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
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
    engineIdx: index("agent_sessions_engine_idx").on(table.engine),
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
    sourceCheck: check(
      "agent_sessions_source_check",
      sql`${table.source} IN ('user', 'agent', 'memory', 'whatsapp')`,
    ),
    engineCheck: check(
      "agent_sessions_engine_check",
      sql`${table.engine} IN ('opencompany', 'codex')`,
    ),
    codexReasoningEffortCheck: check(
      "agent_sessions_codex_reasoning_effort_check",
      sql`${table.codexReasoningEffort} IN ('low', 'medium', 'high', 'xhigh')`,
    ),
    codexPlanModeReasoningEffortCheck: check(
      "agent_sessions_codex_plan_mode_reasoning_effort_check",
      sql`${table.codexPlanModeReasoningEffort} IN ('low', 'medium', 'high', 'xhigh')`,
    ),
  }),
);

export const sessionStars = pgTable(
  "session_stars",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    starredAt: timestamp("starred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userSessionIdx: uniqueIndex("session_stars_user_session_idx").on(table.userId, table.sessionId),
    sessionIdx: index("session_stars_session_idx").on(table.sessionId),
  }),
);

export const agentScheduleRuns = pgTable(
  "agent_schedule_runs",
  {
    id: serial("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    triggerId: text("trigger_id").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    sessionId: text("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"),
    reservationToken: text("reservation_token"),
    pendingExpiresAt: timestamp("pending_expires_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("agent_schedule_runs_workspace_idx").on(table.workspaceId),
    agentIdx: index("agent_schedule_runs_agent_idx").on(table.agentId),
    scheduledForIdx: index("agent_schedule_runs_scheduled_for_idx").on(table.scheduledFor),
    idempotencyIdx: uniqueIndex("agent_schedule_runs_idempotency_idx").on(
      table.agentId,
      table.triggerId,
      table.scheduledFor,
    ),
    statusCheck: check(
      "agent_schedule_runs_status_check",
      sql`${table.status} IN ('pending', 'started', 'failed')`,
    ),
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

export const agentSessionBundleMounts = pgTable(
  "agent_session_bundle_mounts",
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
    sessionIdx: index("agent_session_bundle_mounts_session_idx").on(table.sessionId),
    workspaceIdx: index("agent_session_bundle_mounts_workspace_idx").on(table.workspaceId),
    sessionPathIdx: uniqueIndex("agent_session_bundle_mounts_session_path_idx").on(
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
    // How a user message was dispatched while a run was already in flight (the composer's
    // send-mode picker): "steer" stops the active turn at the next model-step boundary,
    // "queue" lets the active turn finish all its steps first, "interrupt" aborts the active
    // turn (discarding in-flight work) and runs immediately. NULL on idle/first sends and all
    // legacy rows — the runner treats NULL as "steer" so historical behavior is preserved.
    // See docs/agent-turn-vocabulary.md and apps/runner/src/session-lifecycle.ts.
    sendMode: text("send_mode"),
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

// Derived search index over `agent_session_messages` for cross-session recall. The transcript
// (sessions + messages) stays the source of truth; chunks are a rebuildable projection: one row
// per user/assistant message (oversized messages split by char budget into `sub_index` slices),
// indexed for Postgres FTS (`tsv`) and pg_trgm fuzzy/typo matching (`content`). Populated by an
// idempotent sweep (see packages/db/src/recall.ts); searched by the runner-side `recall` tool.
// `agent_id`/`user_id` are denormalized from the session so a scoped search needs no join.
export const agentSessionMessageChunks = pgTable(
  "agent_session_message_chunks",
  {
    id: serial("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => agentSessionMessages.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    subIndex: integer("sub_index").notNull().default(0),
    content: text("content").notNull(),
    messageCreatedAt: timestamp("message_created_at", { withTimezone: true }).notNull(),
    tsv: tsvector("tsv").generatedAlwaysAs((): SQL => sql`to_tsvector('english', "content")`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    messageSubIdx: uniqueIndex("agent_session_message_chunks_message_sub_idx").on(
      table.messageId,
      table.subIndex,
    ),
    // Scope filter for recall: agent + user, with session/recency for ordering and exclusion.
    scopeIdx: index("agent_session_message_chunks_scope_idx").on(
      table.agentId,
      table.userId,
      table.sessionId,
      table.messageCreatedAt,
    ),
    // Neighbor expansion: walk a session's chunks in transcript order.
    sessionOrderIdx: index("agent_session_message_chunks_session_order_idx").on(
      table.sessionId,
      table.messageCreatedAt,
      table.subIndex,
    ),
    // Keyword relevance (FTS) and typo/fuzzy (trigram) — both GIN.
    tsvIdx: index("agent_session_message_chunks_tsv_idx").using("gin", table.tsv),
    contentTrgmIdx: index("agent_session_message_chunks_content_trgm_idx").using(
      "gin",
      table.content.op("gin_trgm_ops"),
    ),
  }),
);

// User-uploaded attachments for a session message (images, PDFs, and text/code files).
// References to Vercel Blob objects only — bytes live in the private Blob store, never in
// Postgres. Cascade-deleted with the message; the blob objects are deleted explicitly in
// app code.
export const agentSessionMessageAttachments = pgTable(
  "agent_session_message_attachments",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => agentSessionMessages.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"image" | "pdf" | "text">().notNull(),
    mediaType: text("media_type").notNull(),
    filename: text("filename").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    blobPathname: text("blob_pathname").notNull(),
    blobUrl: text("blob_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    messageIdx: index("agent_session_message_attachments_message_idx").on(table.messageId),
    sessionIdx: index("agent_session_message_attachments_session_idx").on(table.sessionId),
    kindCheck: check(
      "agent_session_message_attachments_kind_check",
      sql`${table.kind} IN ('image', 'pdf', 'text')`,
    ),
  }),
);

// A user's binding to a messaging transport (WhatsApp today). Scoped to the personal agent —
// messaging is a personal-only surface, so this always points at the user's default agent. Holds
// the link-flow state, the bound peer address, and the rolling session pointer used for the idle
// window. Provider secrets are platform-level env and never stored here.
export const messagingChannels = pgTable(
  "messaging_channels",
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
    // Provider id from @opencompany/messaging (e.g. "whatsapp").
    provider: text("provider").notNull(),
    // disconnected → pending_link (token minted, awaiting the user's first message) → connected.
    status: text("status").notNull().default("disconnected"),
    // The bound peer address (WhatsApp wa_id, E.164 digits, no `+`). Null until the link completes.
    externalId: text("external_id"),
    // The peer's WhatsApp profile/display name, captured at link time for the health view.
    profileName: text("profile_name"),
    // One-time link token rendered into the connect QR; cleared once a peer binds to it.
    linkToken: text("link_token"),
    linkTokenExpiresAt: timestamp("link_token_expires_at", { withTimezone: true }),
    // The session inbound messages currently route into. Reset to null when the idle window lapses
    // so the next inbound message hard-starts a fresh session.
    activeSessionId: text("active_session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    lastError: text("last_error"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // At most one channel per (user, provider) per workspace.
    workspaceUserProviderIdx: uniqueIndex("messaging_channels_workspace_user_provider_idx").on(
      table.workspaceId,
      table.userId,
      table.provider,
    ),
    // Inbound routing key: a bound peer address maps to exactly one channel for a provider. Partial
    // so unbound channels (null external_id) don't collide.
    providerExternalIdx: uniqueIndex("messaging_channels_provider_external_idx")
      .on(table.provider, table.externalId)
      .where(sql`${table.externalId} is not null`),
    // Link-token lookup when the user's first (pre-binding) message arrives.
    linkTokenIdx: index("messaging_channels_link_token_idx").on(table.linkToken),
    activeSessionIdx: index("messaging_channels_active_session_idx").on(table.activeSessionId),
    statusCheck: check(
      "messaging_channels_status_check",
      sql`${table.status} IN ('disconnected', 'pending_link', 'connected', 'error')`,
    ),
  }),
);

// Append-only log of inbound/outbound messages across messaging channels. Serves three jobs:
// inbound idempotency (dedupe provider webhook retries by providerMessageId), outbound delivery
// tracking (pending → sent/failed), and the Channels health view (including unknown-sender hits,
// which have a null channelId). Message bodies are not the system of record — the agent transcript
// is — so we keep only a short preview here.
export const messagingMessages = pgTable(
  "messaging_messages",
  {
    id: text("id").primaryKey(),
    // Null when an unrecognized number messages our platform line (no channel to attribute it to).
    channelId: text("channel_id").references(() => messagingChannels.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    direction: text("direction").notNull(), // 'inbound' | 'outbound'
    // The peer's channel address (wa_id).
    externalContactId: text("external_contact_id").notNull(),
    // Provider-issued message id (WhatsApp wamid). Globally unique across providers, so a single
    // partial-unique index dedupes inbound retries and records outbound delivery ids.
    providerMessageId: text("provider_message_id"),
    sessionId: text("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
    // For outbound rows: the assistant message we delivered.
    agentMessageId: text("agent_message_id").references(() => agentSessionMessages.id, {
      onDelete: "set null",
    }),
    // inbound: 'received' | 'unlinked' | 'linked' ; outbound: 'pending' | 'sent' | 'failed'.
    status: text("status").notNull().default("received"),
    // Truncated body for the health view; not authoritative.
    preview: text("preview"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    channelIdx: index("messaging_messages_channel_idx").on(table.channelId, table.createdAt),
    sessionIdx: index("messaging_messages_session_idx").on(table.sessionId),
    providerMessageIdIdx: uniqueIndex("messaging_messages_provider_message_id_idx")
      .on(table.providerMessageId)
      .where(sql`${table.providerMessageId} is not null`),
    directionCheck: check(
      "messaging_messages_direction_check",
      sql`${table.direction} IN ('inbound', 'outbound')`,
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
    // For runs that spawn a dedicated memory-keeper session (status "spawned"),
    // this links to that background session so the pass is auditable.
    childSessionId: text("child_session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
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
    // No FK to agent_session_messages: this column is overloaded by job kind. message/
    // title/after_session jobs store a message id, `resume_approval`/`resume_question`/
    // `resume_delegation` jobs store the tool_call_id (e.g. resume_delegation's idempotency
    // key is resume_delegation:{parentSessionId}:{parentToolCallId}), and `start` jobs leave
    // it null. Cleanup still cascades via the session_id FK.
    messageId: text("message_id"),
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
      sql`${table.kind} IN ('start', 'message', 'codex_turn', 'title', 'after_session', 'resume_approval', 'resume_question', 'resume_delegation')`,
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

export const agentSessionToolUsage = pgTable(
  "agent_session_tool_usage",
  {
    id: serial("id").primaryKey(),
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
    brokerProviderRequestIdx: uniqueIndex("agent_session_tool_usage_broker_request_idx")
      .on(table.providerRequestId)
      .where(sql`${table.providerRequestId} LIKE 'broker:%'`),
  }),
);

export const agentSessionSandboxUsage = pgTable(
  "agent_session_sandbox_usage",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => agentSessionMessages.id, {
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
    costUsdMicros: bigint("cost_usd_micros", { mode: "number" }).notNull().default(0),
    rawMetrics: jsonb("raw_metrics")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index("agent_session_sandbox_usage_session_idx").on(table.sessionId),
    messageIdx: index("agent_session_sandbox_usage_message_idx").on(table.messageId),
    sessionCreatedAtIdx: index("agent_session_sandbox_usage_session_created_at_idx").on(
      table.sessionId,
      table.createdAt,
    ),
  }),
);

// Per-delegation broker tokens for the runner-hosted LLM broker. Hosted coding
// tools (opencode/codex) and the memory CLI authenticate to the runner's
// reverse proxy with these short-lived opaque tokens instead of raw provider
// keys; the broker meters upstream usage against the token and settles one
// billable agent_session_tool_usage row per token.
export const llmBrokerTokens = pgTable(
  "llm_broker_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    messageId: text("message_id"),
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name").notNull(),
    provider: text("provider").notNull(),
    budgetUsdMicros: bigint("budget_usd_micros", { mode: "number" }),
    spentUsdMicros: bigint("spent_usd_micros", { mode: "number" }).notNull().default(0),
    requestCount: integer("request_count").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    inputCacheReadTokens: bigint("input_cache_read_tokens", { mode: "number" })
      .notNull()
      .default(0),
    inputCacheWriteTokens: bigint("input_cache_write_tokens", { mode: "number" })
      .notNull()
      .default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    unparsedRequestCount: integer("unparsed_request_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    settledToolUsageId: integer("settled_tool_usage_id").references(
      () => agentSessionToolUsage.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex("llm_broker_tokens_token_hash_idx").on(table.tokenHash),
    sessionIdx: index("llm_broker_tokens_session_idx").on(table.sessionId),
    unsettledIdx: index("llm_broker_tokens_unsettled_idx")
      .on(table.expiresAt)
      .where(sql`${table.settledAt} IS NULL`),
    providerCheck: check(
      "llm_broker_tokens_provider_check",
      sql`${table.provider} IN ('gateway', 'openai')`,
    ),
    nonNegativeCountersCheck: check(
      "llm_broker_tokens_non_negative_counters_check",
      sql`(${table.budgetUsdMicros} IS NULL OR ${table.budgetUsdMicros} >= 0)
        AND ${table.spentUsdMicros} >= 0
        AND ${table.requestCount} >= 0
        AND ${table.inputTokens} >= 0
        AND ${table.inputCacheReadTokens} >= 0
        AND ${table.inputCacheWriteTokens} >= 0
        AND ${table.outputTokens} >= 0
        AND ${table.unparsedRequestCount} >= 0`,
    ),
  }),
);

// Per-upstream-request audit rows for the LLM broker. Budget enforcement and
// settlement read the denormalized totals on llm_broker_tokens; these rows are
// for audit, dispute resolution, and the usage-unparseable flag.
export const llmBrokerRequests = pgTable(
  "llm_broker_requests",
  {
    id: serial("id").primaryKey(),
    tokenId: text("token_id")
      .notNull()
      .references(() => llmBrokerTokens.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    endpoint: text("endpoint").notNull(),
    model: text("model"),
    streamed: boolean("streamed").notNull().default(false),
    upstreamStatus: integer("upstream_status"),
    inputTokens: integer("input_tokens").notNull().default(0),
    inputCacheReadTokens: integer("input_cache_read_tokens").notNull().default(0),
    inputCacheWriteTokens: integer("input_cache_write_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsdMicros: bigint("cost_usd_micros", { mode: "number" }).notNull().default(0),
    usageParsed: boolean("usage_parsed").notNull().default(false),
    latencyMs: integer("latency_ms"),
    rawUsage: jsonb("raw_usage")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenIdx: index("llm_broker_requests_token_idx").on(table.tokenId),
    nonNegativeCountersCheck: check(
      "llm_broker_requests_non_negative_counters_check",
      sql`${table.inputTokens} >= 0
        AND ${table.inputCacheReadTokens} >= 0
        AND ${table.inputCacheWriteTokens} >= 0
        AND ${table.outputTokens} >= 0
        AND ${table.costUsdMicros} >= 0
        AND (${table.latencyMs} IS NULL OR ${table.latencyMs} >= 0)`,
    ),
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
    id: serial("id").primaryKey(),
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
    modelUsageId: integer("model_usage_id").references(() => agentSessionUsage.id, {
      onDelete: "set null",
    }),
    toolUsageId: integer("tool_usage_id").references(() => agentSessionToolUsage.id, {
      onDelete: "set null",
    }),
    sandboxUsageId: integer("sandbox_usage_id").references(() => agentSessionSandboxUsage.id, {
      onDelete: "set null",
    }),
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
    sandboxUsageIdx: uniqueIndex("workspace_credit_ledger_sandbox_usage_idx")
      .on(table.sandboxUsageId)
      .where(sql`${table.sandboxUsageId} IS NOT NULL`),
    signupBonusIdx: uniqueIndex("workspace_credit_ledger_signup_bonus_idx")
      .on(table.workspaceId)
      .where(sql`${table.source} = 'signup_bonus'`),
  }),
);

// Per-workspace billing controls: weekly spending limit (pauses runs at the cap)
// and automatic refill (off-session top-up via a saved card when the balance runs
// low). One row per workspace; absent row means "all defaults / disabled".
export const workspaceBillingSettings = pgTable("workspace_billing_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  spendLimitEnabled: boolean("spend_limit_enabled").notNull().default(false),
  // NULL = no limit configured. Enforced only when spendLimitEnabled is true.
  weeklySpendLimitUsdMicros: bigint("weekly_spend_limit_usd_micros", { mode: "number" }),
  autoRefillEnabled: boolean("auto_refill_enabled").notNull().default(false),
  // When the balance drops below this threshold, charge the saved card for the amount.
  autoRefillThresholdUsdMicros: bigint("auto_refill_threshold_usd_micros", { mode: "number" }),
  autoRefillAmountUsdMicros: bigint("auto_refill_amount_usd_micros", { mode: "number" }),
  stripeCustomerId: text("stripe_customer_id"),
  stripeDefaultPaymentMethodId: text("stripe_default_payment_method_id"),
  // Display-only card hints captured when the payment method is saved.
  cardBrand: text("card_brand"),
  cardLast4: text("card_last4"),
  // "ok" | "needs_attention" — set when an off-session charge is declined or needs auth.
  autoRefillStatus: text("auto_refill_status").notNull().default("ok"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Audit + idempotency record for each off-session auto-refill charge. Mirrors the
// shape of stripeCheckoutSessions. Crediting is guarded by a conditional status
// transition (pending -> succeeded) so webhook retries never double-credit.
export const autoRefillAttempts = pgTable(
  "auto_refill_attempts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    amountUsdMicros: bigint("amount_usd_micros", { mode: "number" }).notNull(),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
  },
  (table) => ({
    paymentIntentIdx: uniqueIndex("auto_refill_attempts_payment_intent_idx")
      .on(table.stripePaymentIntentId)
      .where(sql`${table.stripePaymentIntentId} IS NOT NULL`),
    workspaceCreatedAtIdx: index("auto_refill_attempts_workspace_created_at_idx").on(
      table.workspaceId,
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

export const workspaceCodexCredentials = pgTable(
  "workspace_codex_credentials",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    encryptedAuthJson: jsonb("encrypted_auth_json")
      .$type<WorkspaceIntegrationCredentialEncryptedPayload>()
      .notNull(),
    encryptionKeyVersion: integer("encryption_key_version").notNull(),
    status: text("status").$type<WorkspaceCodexCredentialStatus>().notNull().default("connected"),
    statusReason: text("status_reason"),
    connectedByUserId: text("connected_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("workspace_codex_credentials_status_idx").on(table.status),
    connectedByUserIdx: index("workspace_codex_credentials_connected_by_user_idx").on(
      table.connectedByUserId,
    ),
    statusCheck: check(
      "workspace_codex_credentials_status_check",
      sql`${table.status} IN ('connected', 'needs_reauth')`,
    ),
  }),
);

export const workspaceCodexDeviceAuthFlows = pgTable(
  "workspace_codex_device_auth_flows",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requestedByUserId: text("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    sandboxId: text("sandbox_id").notNull(),
    userCode: text("user_code"),
    verificationUri: text("verification_uri"),
    status: text("status").$type<WorkspaceCodexDeviceAuthFlowStatus>().notNull().default("pending"),
    statusReason: text("status_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceStatusIdx: index("workspace_codex_device_auth_flows_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
    expiresAtIdx: index("workspace_codex_device_auth_flows_expires_at_idx").on(table.expiresAt),
    statusCheck: check(
      "workspace_codex_device_auth_flows_status_check",
      sql`${table.status} IN ('pending', 'code_ready', 'completed', 'failed', 'expired')`,
    ),
  }),
);

export const workspaceToolPolicies = pgTable(
  "workspace_tool_policies",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    permissionGroup: text("permission_group")
      .$type<"read" | "post" | "modify" | "merge" | "admin">()
      .notNull(),
    decision: text("decision").$type<"allow" | "ask" | "deny">().notNull(),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceProviderGroupIdx: uniqueIndex("workspace_tool_policies_ws_provider_group_idx").on(
      table.workspaceId,
      table.providerKey,
      table.permissionGroup,
    ),
    workspaceIdx: index("workspace_tool_policies_workspace_idx").on(table.workspaceId),
    groupCheck: check(
      "workspace_tool_policies_group_check",
      sql`${table.permissionGroup} IN ('read', 'post', 'modify', 'merge', 'admin')`,
    ),
    decisionCheck: check(
      "workspace_tool_policies_decision_check",
      sql`${table.decision} IN ('allow', 'ask', 'deny')`,
    ),
  }),
);

export const agentToolApprovals = pgTable(
  "agent_tool_approvals",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    messageId: text("message_id"),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    providerKey: text("provider_key").notNull(),
    permissionGroup: text("permission_group")
      .$type<"read" | "post" | "modify" | "merge" | "admin">()
      .notNull(),
    status: text("status").$type<"pending" | "approved" | "denied">().notNull().default("pending"),
    inputPreview: text("input_preview"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByUserId: text("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decisionSource: text("decision_source").$type<"user" | "timeout" | "abort">(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionToolCallIdx: uniqueIndex("agent_tool_approvals_session_tool_call_idx").on(
      table.sessionId,
      table.toolCallId,
    ),
    sessionStatusIdx: index("agent_tool_approvals_session_status_idx").on(
      table.sessionId,
      table.status,
    ),
    groupCheck: check(
      "agent_tool_approvals_group_check",
      sql`${table.permissionGroup} IN ('read', 'post', 'modify', 'merge', 'admin')`,
    ),
    statusCheck: check(
      "agent_tool_approvals_status_check",
      sql`${table.status} IN ('pending', 'approved', 'denied')`,
    ),
    decisionSourceCheck: check(
      "agent_tool_approvals_decision_source_check",
      sql`${table.decisionSource} IS NULL OR ${table.decisionSource} IN ('user', 'timeout', 'abort')`,
    ),
  }),
);

// The durable handoff for the ask_user_question tool. Mirrors agentToolApprovals: the model's
// tool-call suspends the run and writes a pending row here; a web action / backstop flips it to
// answered/cancelled and triggers a resume run that synthesizes the tool-result from `answers`.
export const agentSessionQuestions = pgTable(
  "agent_session_questions",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    messageId: text("message_id"),
    toolCallId: text("tool_call_id").notNull(),
    // The questions the model asked (array of {header, question, options[], allowMultiple, allowOther}).
    questions: jsonb("questions").$type<AgentSessionQuestionPrompt[]>().notNull(),
    // The user's answers, one entry per question in order. Null until answered.
    answers: jsonb("answers").$type<AgentSessionQuestionAnswer[]>(),
    status: text("status")
      .$type<"pending" | "answered" | "cancelled">()
      .notNull()
      .default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    answeredByUserId: text("answered_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolutionSource: text("resolution_source").$type<
      "user" | "abort" | "timeout" | "superseded"
    >(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionToolCallIdx: uniqueIndex("agent_session_questions_session_tool_call_idx").on(
      table.sessionId,
      table.toolCallId,
    ),
    sessionStatusIdx: index("agent_session_questions_session_status_idx").on(
      table.sessionId,
      table.status,
    ),
    statusCheck: check(
      "agent_session_questions_status_check",
      sql`${table.status} IN ('pending', 'answered', 'cancelled')`,
    ),
    resolutionSourceCheck: check(
      "agent_session_questions_resolution_source_check",
      sql`${table.resolutionSource} IS NULL OR ${table.resolutionSource} IN ('user', 'abort', 'timeout', 'superseded')`,
    ),
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

// A forward-flexible artifact attached to an inbox item. v1 renders `fyi` only; `actions` and
// `reply` are stored so the agent can attach them now and we can make them interactive later.
export type InboxItemArtifact =
  | { kind: "fyi" }
  | {
      kind: "actions";
      actions: { id: string; label: string; tone?: "primary" | "default" | "danger" }[];
    }
  | { kind: "reply"; placeholder?: string; suggestions?: string[] };

// Personal-agent inbox: attention items an agent posts for a user to triage. Scoped per
// (workspace, user). The agent writes via the inbox_list/inbox_add/inbox_update tools (runner,
// internal kind); the user triages from the /personal inbox (done / snooze 6h / dismiss). A
// snoozed row keeps status='snoozed' + snoozed_until so the agent still sees it; the UI hides it
// until snoozed_until elapses. Only live items (open/snoozed) are synced to the client.
export const inboxItems = pgTable(
  "inbox_items",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Provenance: the agent session that created the item, so the UI can link back to it.
    sourceSessionId: text("source_session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    // Free-text origin label shown on the card (the agent's name or a schedule name).
    source: text("source"),
    title: text("title").notNull(),
    // Markdown summary / FYI body.
    body: text("body"),
    // "What happened": the agent's steps leading to this item.
    steps: jsonb("steps").$type<string[]>(),
    priority: text("priority").$type<"urgent" | "high" | "med" | "low">(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    // Forward-flexible payload; defaults to a plain FYI.
    artifact: jsonb("artifact").$type<InboxItemArtifact>(),
    status: text("status")
      .$type<"open" | "snoozed" | "done" | "dismissed">()
      .notNull()
      .default("open"),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    // Optional agent-supplied key; a live (open/snoozed) duplicate makes inbox_add a no-op.
    dedupKey: text("dedup_key"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    workspaceUserIdx: index("inbox_items_workspace_user_idx").on(table.workspaceId, table.userId),
    statusIdx: index("inbox_items_status_idx").on(table.workspaceId, table.userId, table.status),
    // One live item per dedup key per user, so inbox_add can no-op a re-post on a schedule rerun.
    dedupIdx: uniqueIndex("inbox_items_dedup_idx")
      .on(table.workspaceId, table.userId, table.dedupKey)
      .where(sql`${table.dedupKey} IS NOT NULL AND ${table.status} IN ('open', 'snoozed')`),
    statusCheck: check(
      "inbox_items_status_check",
      sql`${table.status} IN ('open', 'snoozed', 'done', 'dismissed')`,
    ),
    priorityCheck: check(
      "inbox_items_priority_check",
      sql`${table.priority} IS NULL OR ${table.priority} IN ('urgent', 'high', 'med', 'low')`,
    ),
  }),
);

export const inboxItemsRelations = relations(inboxItems, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [inboxItems.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [inboxItems.userId],
    references: [users.id],
  }),
  sourceSession: one(agentSessions, {
    fields: [inboxItems.sourceSessionId],
    references: [agentSessions.id],
  }),
}));

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
    // Free-text answer to "what do you want to accomplish with opencompany?".
    // Optional — users may leave it empty.
    goal: text("goal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("onboarding_responses_workspace_idx").on(table.workspaceId),
  }),
);

export type SlackChannelStatus = "pending" | "active" | "failed";

// One private Slack Connect support channel per workspace, provisioned after the
// customer's first onboarding. Unique workspaceId + the "already active" short-circuit
// in the Inngest provisioning function guarantee exactly one channel per workspace
// even under retries or a double event dispatch.
export const workspaceSlackChannels = pgTable(
  "workspace_slack_channels",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slackChannelId: text("slack_channel_id"),
    slackTeamId: text("slack_team_id"),
    inviteUrl: text("invite_url"),
    status: text("status").$type<SlackChannelStatus>().notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: uniqueIndex("workspace_slack_channels_workspace_idx").on(table.workspaceId),
    statusCheck: check(
      "workspace_slack_channels_status_check",
      sql`${table.status} IN ('pending', 'active', 'failed')`,
    ),
  }),
);

export const connectorUsersRelations = relations(connectorUsers, ({ many }) => ({
  createdOrganizations: many(connectorOrganizations),
  memberships: many(connectorOrganizationMemberships),
  connectedMcpServers: many(connectorMcpServers),
}));

export const connectorOrganizationsRelations = relations(
  connectorOrganizations,
  ({ one, many }) => ({
    createdBy: one(connectorUsers, {
      fields: [connectorOrganizations.createdByUserId],
      references: [connectorUsers.id],
    }),
    memberships: many(connectorOrganizationMemberships),
    mcpServers: many(connectorMcpServers),
    mcpCredentials: many(connectorMcpCredentials),
    permissionGrants: many(connectorPermissionGrants),
  }),
);

export const connectorOrganizationMembershipsRelations = relations(
  connectorOrganizationMemberships,
  ({ one }) => ({
    organization: one(connectorOrganizations, {
      fields: [connectorOrganizationMemberships.organizationId],
      references: [connectorOrganizations.id],
    }),
    user: one(connectorUsers, {
      fields: [connectorOrganizationMemberships.userId],
      references: [connectorUsers.id],
    }),
  }),
);

export const connectorMcpServersRelations = relations(connectorMcpServers, ({ one, many }) => ({
  organization: one(connectorOrganizations, {
    fields: [connectorMcpServers.organizationId],
    references: [connectorOrganizations.id],
  }),
  connectedByUser: one(connectorUsers, {
    fields: [connectorMcpServers.connectedByUserId],
    references: [connectorUsers.id],
  }),
  credentials: many(connectorMcpCredentials),
}));

export const connectorMcpCredentialsRelations = relations(connectorMcpCredentials, ({ one }) => ({
  organization: one(connectorOrganizations, {
    fields: [connectorMcpCredentials.organizationId],
    references: [connectorOrganizations.id],
  }),
  server: one(connectorMcpServers, {
    fields: [connectorMcpCredentials.serverId, connectorMcpCredentials.organizationId],
    references: [connectorMcpServers.id, connectorMcpServers.organizationId],
  }),
}));

export const connectorPermissionGrantsRelations = relations(
  connectorPermissionGrants,
  ({ one }) => ({
    organization: one(connectorOrganizations, {
      fields: [connectorPermissionGrants.organizationId],
      references: [connectorOrganizations.id],
    }),
  }),
);

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(workspaceMemberships),
  createdWorkspaces: many(workspaces),
  agentSessions: many(agentSessions),
  sessionStars: many(sessionStars),
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
  brainFiles: many(brainFiles),
  agentFiles: many(agentFiles),
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
  user: one(users, {
    fields: [agents.userId],
    references: [users.id],
  }),
  files: many(agentFiles),
  sessions: many(agentSessions),
}));

export const brainFilesRelations = relations(brainFiles, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [brainFiles.workspaceId],
    references: [workspaces.id],
  }),
}));

export const agentFilesRelations = relations(agentFiles, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [agentFiles.workspaceId],
    references: [workspaces.id],
  }),
  agent: one(agents, {
    fields: [agentFiles.agentId],
    references: [agents.id],
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
  bundleMounts: many(agentSessionBundleMounts),
  artifacts: many(agentSessionArtifacts),
  runJobs: many(agentSessionRunJobs),
  stars: many(sessionStars),
}));

export const sessionStarsRelations = relations(sessionStars, ({ one }) => ({
  user: one(users, {
    fields: [sessionStars.userId],
    references: [users.id],
  }),
  session: one(agentSessions, {
    fields: [sessionStars.sessionId],
    references: [agentSessions.id],
  }),
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

export const agentSessionBundleMountsRelations = relations(agentSessionBundleMounts, ({ one }) => ({
  session: one(agentSessions, {
    fields: [agentSessionBundleMounts.sessionId],
    references: [agentSessions.id],
  }),
  workspace: one(workspaces, {
    fields: [agentSessionBundleMounts.workspaceId],
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

export const workspaceBillingSettingsRelations = relations(workspaceBillingSettings, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceBillingSettings.workspaceId],
    references: [workspaces.id],
  }),
}));

export const autoRefillAttemptsRelations = relations(autoRefillAttempts, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [autoRefillAttempts.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [autoRefillAttempts.userId],
    references: [users.id],
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
export type WorkspaceBillingSettings = typeof workspaceBillingSettings.$inferSelect;
export type AutoRefillAttempt = typeof autoRefillAttempts.$inferSelect;
export type CreditCode = typeof creditCodes.$inferSelect;
export type CreditCodeRedemption = typeof creditCodeRedemptions.$inferSelect;
export type AgentScheduleRun = typeof agentScheduleRuns.$inferSelect;
export type BrainFile = typeof brainFiles.$inferSelect;
export type AgentFile = typeof agentFiles.$inferSelect;
export type WorkspaceSyncJob = typeof workspaceSyncJobs.$inferSelect;
export type AgentSession = typeof agentSessions.$inferSelect;
export type SessionStar = typeof sessionStars.$inferSelect;
export type AgentSessionBrainMount = typeof agentSessionBrainMounts.$inferSelect;
export type AgentSessionBundleMount = typeof agentSessionBundleMounts.$inferSelect;
export type AgentSessionMessage = typeof agentSessionMessages.$inferSelect;
export type AgentSessionEvent = typeof agentSessionEvents.$inferSelect;
export type AgentSessionUsage = typeof agentSessionUsage.$inferSelect;
export type AgentSessionArtifact = typeof agentSessionArtifacts.$inferSelect;
export type AgentSessionToolUsage = typeof agentSessionToolUsage.$inferSelect;
export type AgentSessionRunJob = typeof agentSessionRunJobs.$inferSelect;
export type WorkspaceMembership = typeof workspaceMemberships.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type OnboardingResponse = typeof onboardingResponses.$inferSelect;
export type WorkspaceToolPolicy = typeof workspaceToolPolicies.$inferSelect;
export type AgentToolApproval = typeof agentToolApprovals.$inferSelect;
export type AgentSessionQuestion = typeof agentSessionQuestions.$inferSelect;
export type MessagingChannel = typeof messagingChannels.$inferSelect;
export type MessagingMessage = typeof messagingMessages.$inferSelect;
