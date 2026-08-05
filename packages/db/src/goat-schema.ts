import type { AgentModelId, CodexReasoningEffort } from "@opencompany/agent-runtime/types";
import type { EncryptedPayload } from "@opencompany/crypto";
import { relations, type SQL, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Postgres full-text search vector, written only by the database (a STORED generated column over
// `search_text`). Same pattern as the recall index in schema.ts.
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// pgvector embedding, serialized as its text literal ("[0.1,0.2,...]"). Dimension is intentionally
// unconstrained: rows are only ever compared against vectors from the same model (the `model`
// column gates staleness), so a model swap needs no DDL.
const vector = customType<{ data: string }>({
  dataType() {
    return "vector";
  },
});

export type GoatTaskStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

// Workflows and skills share a simple draft/active lifecycle: `draft` is
// editable-but-not-yet-usable, `active` is available to fire (workflows) or
// attach (skills). Mirrors the frontmatter `status` the Brain docs carried.
export type GoatWorkflowStatus = "draft" | "active";
export type GoatWorkflowTrigger = "manual" | "slack" | "linear" | "schedule";
export type GoatWorkflowStep = {
  id: string;
  title: string;
  // Workflow editor runtime token (e.g. "kimi-k2.6", "codex", "claude-code").
  model: string;
  // Concrete cloud-coding model selected when `model` is "codex" or "claude-code".
  runtimeModel?: AgentModelId;
  reasoningEffort?: CodexReasoningEffort;
  instructions: string;
};
export type GoatSkillStatus = "draft" | "active";

export type GoatHarnessEngine = "opencompany" | "codex" | "claude_code";

export type GoatTaskStage =
  | "queued"
  | "planning"
  | "sandboxing"
  | "running"
  | "completed"
  | "failed"
  | "canceled";
export type GoatTaskScheduleRunStatus = "pending" | "created" | "failed";
export type GoatChatSessionKind = "chat" | "task";
export type GoatChatModelRoutingTier = "standard" | "frontier";
export type GoatChatModelRoutingReason =
  | "pdf_attachment"
  | "attachment"
  | "simple_answer"
  | "summarization"
  | "drafting"
  | "single_action"
  | "multi_step"
  | "analysis"
  | "coding"
  | "high_stakes"
  | "ambiguous"
  | "router_fallback";
export type GoatChatModelRoutingOutcome = "success" | "skipped" | "timeout" | "error" | "invalid";
export type GoatChatModelRoutingErrorCategory =
  | "output_length"
  | "invalid_output"
  | "timeout"
  | "rate_limit"
  | "provider"
  | "unknown";

export type GoatIntegrationProvider =
  | "gmail"
  | "google_calendar"
  | "google_drive"
  | "linear"
  | "github"
  | "jamie"
  | "slack"
  | "slack_bot"
  | "hubspot"
  | "granola"
  | "fathom"
  | "attio"
  | "stripe"
  | "latitude"
  | "posthog"
  | "neon"
  | "imessage";
// Ownership is a property of the integration's binding, not a per-connect
// choice. Identity-bound connections (OAuth acting as a person: Gmail,
// Calendar, Slack user token, Linear, PostHog, Neon) are always personal. Installation-bound
// connections (GitHub App org installs, Jamie webhook secrets, the Slack
// answer-bot install) are workspace plumbing: they carry no human identity,
// must survive the connecting admin leaving, and are manageable by any
// workspace admin.
export const WORKSPACE_OWNED_GOAT_INTEGRATION_PROVIDERS = [
  "github",
  "jamie",
  "slack_bot",
  "stripe",
] as const satisfies readonly GoatIntegrationProvider[];
export function isWorkspaceOwnedGoatIntegrationProvider(provider: GoatIntegrationProvider) {
  return (
    WORKSPACE_OWNED_GOAT_INTEGRATION_PROVIDERS as readonly GoatIntegrationProvider[]
  ).includes(provider);
}
export type GoatIntegrationStatus = "connected" | "needs_reauth" | "sync_failed" | "disconnected";
export type GoatImessageSendSource = "chat" | "task" | "pairing";
export type GoatImessageSendStatus = "sent" | "failed";
export type GoatIntegrationCredentialKind = "oauth_token" | "webhook_secret" | "api_key";
export type GoatIntegrationCredentialEncryptedPayload = EncryptedPayload;
export type GoatBrowserProfileStatus =
  | "pending_login"
  | "connected"
  | "needs_reauth"
  | "disconnected";
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
export type GoatBrainSourceProvider =
  | "jamie"
  | "goat-chat"
  | "goat-import"
  | "upload"
  | "slack"
  | "linear"
  | "github"
  | "gmail"
  | "google_drive"
  | "hubspot"
  | "granola"
  | "fathom"
  | "attio";
// "slack_bot" rows are answer *destinations* (which channels a brain answers
// in via the Slack bot), not ingestion sources; no ingestion path reads them.
export type GoatBrainSourceConfigProvider =
  | "jamie"
  | "gmail"
  | "google_drive"
  | "github"
  | "slack"
  | "linear"
  | "slack_bot"
  | "hubspot"
  | "granola"
  | "fathom"
  | "attio";
export type GoatBrainSourceType =
  | "meeting"
  | "run"
  | "capture"
  | "pointer"
  | "asset"
  | "conversation"
  | "issue"
  | "activity"
  | "thread"
  | "document";
export type GoatGoogleDriveWatchChannelStatus = "creating" | "active" | "stopped";
export type GoatGmailMessageDirection = "sent" | "received";
export type GoatSlackChannelType = "channel" | "group" | "im" | "mpim";
export type GoatLinearEventEntityType = "issue" | "comment";
export type GoatLinearEventAction = "create" | "update" | "remove";
export type GoatGitHubPullRequestEventType =
  | "pull_request_opened"
  | "pull_request_merged"
  | "pull_request_commented";
export type GoatHubspotObjectType = "contact" | "company" | "deal";
export type GoatHubspotEventAction = "create" | "update";
export type GoatAttioObjectType = "person" | "company" | "deal";
export type GoatAttioEventAction = "create" | "update" | "note";
export type GoatBrainSourceItemIngestStatus = "pending" | "succeeded" | "failed" | "skipped";
export type GoatBrainIngestJobKind =
  | "brain_source_item_ingest"
  | "brain_agent_ingest"
  | "brain_pointer_hydrate";
export type GoatBrainIngestJobStatus = "queued" | "running" | "succeeded" | "failed" | "skipped";
export type GoatBrainImportStatus =
  | "discovering"
  | "awaiting_confirmation"
  | "ingesting"
  | "finalizing"
  | "succeeded"
  | "partial"
  | "failed"
  | "canceled";
export type GoatBrainImportProvider =
  | "public_web"
  | "github"
  | "jamie"
  | "granola"
  | "fathom"
  | "gmail"
  | "slack"
  | "linear";
export type GoatBrainImportSourceSelection = Partial<
  Record<
    GoatBrainImportProvider,
    {
      enabled: boolean;
      integrationId?: string;
      config?: Record<string, unknown>;
    }
  >
>;
export type GoatBrainImportProviderSummary = {
  status: "pending" | "ready" | "failed" | "unavailable";
  discoveredEntries: number;
  eligibleEntries: number;
  alreadyKnownEntries: number;
  selectedEntries: number;
  plannedRuns: number;
  searchCount?: number;
  resultCount?: number;
  error?: string;
};
export type GoatBrainImportDiscoverySummary = Partial<
  Record<GoatBrainImportProvider, GoatBrainImportProviderSummary>
>;

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
  | "latitude_search_tools"
  | "latitude_use_tool"
  | "github_clone_repository"
  | "github_shell"
  | "github_status"
  | "github_open_pull_request"
  // Shared main-chat tools, used by opencompany-engine task runs (tasks are a
  // hidden main-chat run). Persisted to goat.task_messages.tool_name (text).
  | "goat_brain"
  | "save_to_brain"
  | "web_search"
  | "web_fetch"
  | "list_actions"
  | "use_action"
  | "update_task_status";

export type GoatTaskSkillId = "first-principles" | "yc-office-hours";

export type GoatTaskReportedOutcome = "done" | "needs_attention";

export type GoatHarnessWorkflowStep = {
  index: number;
  title: string;
  engine: GoatHarnessEngine;
  model: AgentModelId;
  reasoningEffort?: CodexReasoningEffort;
  systemPrompt: string;
  systemBlocks: string[];
  skillIds: string[];
};

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
  // Extra system-prompt blocks appended after the shared chat system prompt for
  // opencompany-engine task runs (e.g. compiled workflow instructions + skills).
  // The runner's chat loop feeds these as extraSystemBlocks.
  systemBlocks?: string[];
  workflow?: {
    // The workspace-scoped workflow slug that spawned this task.
    id: string;
    workspaceId: string;
    skillIds: string[];
    steps?: GoatHarnessWorkflowStep[];
    currentStepIndex?: number;
    completedStepCount?: number;
    lastCompletedStepOutcome?: {
      reportedOutcome: GoatTaskReportedOutcome | null;
      outcomeComment: string | null;
    };
  };
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
export type GoatMcpClient = "claude" | "chatgpt" | "cursor";
export type GoatTaskViewMode = "board" | "list";
export type GoatWorkspacePlan = "free" | "pro";
export type GoatStripeSubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";
export type GoatIngestionReservationStatus = "pending" | "consumed";
export type GoatBrainIntelligence = "basic" | "frontier";
// "frontier_ingest" and "ingest_overage" are legacy v3 sources kept for
// historical rows; v4 writes "ingest_model_usage" (per attempt, all tiers)
// and "ingest_fee" (flat per-item fee at reservation admission).
export type GoatCreditLedgerSource =
  | "starter_grant"
  | "seat_included_grant"
  | "seat_included_expiration"
  | "stripe_topup"
  | "chat_model_usage"
  | "capability_usage"
  | "frontier_ingest"
  | "ingest_overage"
  | "ingest_model_usage"
  | "ingest_fee"
  | "adjustment";
export type GoatManagedCapabilitySource =
  | "x"
  | "linkedin"
  | "youtube"
  | "instagram"
  | "tiktok"
  | "lead"
  | "seo";
export type GoatCapabilityRunStatus =
  | "awaiting_approval"
  | "approved"
  | "canceled"
  | "expired"
  | "executing"
  | "running"
  | "stopping"
  | "succeeded"
  | "failed"
  | "stopped"
  | "timed_out";
export type GoatCheckoutSessionStatus = "pending" | "open" | "fulfilled" | "failed";
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
export type GoatBrainDocumentFormat = "markdown" | "pdf" | "docx" | "xlsx" | "srt" | "image";
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
export type GoatChatEngine = "opencompany" | "codex" | "claude_code";
// Engines whose durable turns run through the legacy-named goat.codex_chat_* queue.
export type GoatCodexChatEngine = GoatChatEngine;

export type GoatChatAttachmentKind = "image" | "pdf" | "docx" | "xlsx" | "srt";
export type GoatChatMessageAttachment = {
  id: string;
  kind: GoatChatAttachmentKind;
  mediaType: string;
  filename: string;
  sizeBytes: number;
  blobPathname: string;
  blobUrl: string;
};

export type GoatCodexChatSessionStatus =
  | "queued"
  | "starting"
  | "idle"
  | "running"
  | "failed"
  | "interrupted"
  | "closed";
export type GoatCodexChatTurnStatus = "queued" | "running" | "completed" | "failed" | "interrupted";
export const GOAT_CODEX_APP_SERVER_EVENT_TYPES = [
  "assistant.delta",
  "assistant.completed",
  "reasoning.completed",
  "command.started",
  "command.output",
  "command.completed",
  "command.failed",
  "file_change.started",
  "file_change.completed",
  "mcp_tool.started",
  "mcp_tool.completed",
  "subagent.started",
  "subagent.completed",
  "dynamic_tool.started",
  "dynamic_tool.completed",
  "web_search.started",
  "web_search.completed",
  "plan.updated",
  "goal.updated",
  "question.requested",
  "approval.requested",
  "turn.started",
  "turn.completed",
  "usage.updated",
  "error",
  "unknown",
] as const;
export type GoatCodexAppServerEventType = (typeof GOAT_CODEX_APP_SERVER_EVENT_TYPES)[number];
export type GoatCodexChatEventType = Exclude<
  GoatCodexAppServerEventType,
  "assistant.delta" | "command.output"
>;
export const GOAT_CODEX_CHAT_EVENT_TYPES: readonly GoatCodexChatEventType[] =
  GOAT_CODEX_APP_SERVER_EVENT_TYPES.filter(
    (eventType): eventType is GoatCodexChatEventType =>
      eventType !== "assistant.delta" && eventType !== "command.output",
  );

export type GoatCodexChatTurnSettings = {
  reasoningEffort?: CodexReasoningEffort;
  planModeReasoningEffort?: CodexReasoningEffort | null;
  wakeupChain?: number;
  scheduledWakeup?: {
    delaySeconds: number;
    reason: string;
    prompt: string;
  };
  goalMode?: {
    objective: string;
    tokenBudget?: number | null;
  } | null;
};

export type GoatCodexChatInteractionStatus = "pending" | "resolved" | "canceled";

export type GoatChatMessageDebugTrace = {
  schemaVersion?: "opencompany.chat.debug.v1" | "goat.chat.debug.v1" | "goat.codex_chat.debug.v1";
  model?: string;
  aborted?: boolean;
  finishReason?: string;
  uiMessageParts?: unknown[];
  toolCalls?: unknown[];
  toolResults?: unknown[];
  durationMs?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  // Worker-side transcripts of use_capability calls (steps, tool previews),
  // keyed by toolCallId; never part of the model-visible tool output.
  capabilityCalls?: unknown[];
  scheduledWakeup?: {
    reason: string;
    dueAt: string;
  };
  error?: string;
};

export type GoatBrainToolRunTrace = Record<string, unknown>;

export const goat = pgSchema("goat");
export const goatTaskDisplayIdSequence = goat.sequence("task_display_id_seq");

export const goatUsers = goat.table(
  "users",
  {
    workosUserId: text("workos_user_id").primaryKey(),
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    avatarUrl: text("avatar_url"),
    timezone: text("timezone").notNull().default("UTC"),
    taskSpawningEnabled: boolean("task_spawning_enabled").notNull().default(false),
    autoModelRoutingEnabled: boolean("auto_model_routing_enabled").notNull().default(false),
    chatCapabilitiesBetaEnabled: boolean("chat_capabilities_beta_enabled").notNull().default(false),
    imessageEnabled: boolean("imessage_enabled").notNull().default(false),
    // Board vs list layout for the Tasks page; persisted per user across devices.
    taskViewMode: text("task_view_mode").notNull().default("board").$type<GoatTaskViewMode>(),
    preferredMcpClient: text("preferred_mcp_client").$type<GoatMcpClient>(),
    // Set exactly once, when this user first completes a successful Brain query over MCP.
    mcpSetupCompletedAt: timestamp("mcp_setup_completed_at", { withTimezone: true }),
    // Set when the user finishes the onboarding flow; null gates them into it.
    onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    preferredMcpClientCheck: check(
      "goat_users_preferred_mcp_client_check",
      sql`${table.preferredMcpClient} IS NULL OR ${table.preferredMcpClient} IN ('claude', 'chatgpt', 'cursor')`,
    ),
    taskViewModeCheck: check(
      "goat_users_task_view_mode_check",
      sql`${table.taskViewMode} IN ('board', 'list')`,
    ),
  }),
);

export const goatWorkspaces = goat.table(
  "workspaces",
  {
    id: text("id").primaryKey(),
    workosOrganizationId: text("workos_organization_id"),
    name: text("name").notNull(),
    // URL slug chosen at onboarding. Nullable (Postgres treats NULLs as distinct,
    // so the unique index permits many not-yet-set workspaces).
    slug: text("slug"),
    createdByWorkosId: text("created_by_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "restrict" }),
    capabilitySessionBudgetUsdMicros: bigint("capability_session_budget_usd_micros", {
      mode: "number",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workosOrganizationIdx: uniqueIndex("goat_workspaces_workos_organization_idx").on(
      table.workosOrganizationId,
    ),
    slugIdx: uniqueIndex("goat_workspaces_slug_idx").on(table.slug),
  }),
);

// One row per user capturing what the onboarding flow collected. Owner flows set
// referral + company context; invited members only ever set (or skip) referral.
export const goatOnboarding = goat.table("onboarding", {
  userWorkosId: text("user_workos_id")
    .primaryKey()
    .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").references(() => goatWorkspaces.id, {
    onDelete: "set null",
  }),
  referralSource: text("referral_source"),
  // Self-reported profile captured on the first onboarding step. `role` is one
  // of the ROLE_PROFILES ids in the wizard and seeds the tailored brain folders.
  role: text("role"),
  // Legacy free-text field retained for existing rows. New Goat onboarding
  // stores the normalized hostname in companyDomain and the homepage URL in
  // contextUrls.
  building: text("building"),
  companyDomain: text("company_domain"),
  contextUrls: jsonb("context_urls").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GoatOnboardingEmailStep = "welcome" | "checkin" | "feedback_call";
export type GoatOnboardingEmailStatus = "pending" | "sending" | "sent" | "failed" | "skipped";

// One row per (owner, step) of the founder onboarding drip. Enrollment inserts
// three rows at first-workspace creation; a cron sweep claims due `pending` rows
// (status flips to `sending` under a soft lease), sends via Resend, then marks
// `sent`. The unique (user, step) index makes enrollment idempotent and gives
// each send a stable Resend idempotency key. Only owners are enrolled — invited
// members never reach the create-workspace branch that triggers it.
export const goatOnboardingEmails = goat.table(
  "onboarding_emails",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workosUserId: text("workos_user_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    step: text("step").$type<GoatOnboardingEmailStep>().notNull(),
    status: text("status").$type<GoatOnboardingEmailStatus>().notNull().default("pending"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userStepIdx: uniqueIndex("goat_onboarding_emails_user_step_idx").on(
      table.workosUserId,
      table.step,
    ),
    statusScheduledIdx: index("goat_onboarding_emails_status_scheduled_idx").on(
      table.status,
      table.scheduledAt,
    ),
    stepCheck: check(
      "goat_onboarding_emails_step_check",
      sql`${table.step} IN ('welcome', 'checkin', 'feedback_call')`,
    ),
    statusCheck: check(
      "goat_onboarding_emails_status_check",
      sql`${table.status} IN ('pending', 'sending', 'sent', 'failed', 'skipped')`,
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

// OpenCompany-managed paid capabilities are workspace features, not user
// integrations. Missing rows mean enabled; this table stores only explicit
// workspace overrides.
export const goatWorkspaceCapabilities = goat.table(
  "workspace_capabilities",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => goatWorkspaces.id, { onDelete: "cascade" }),
    source: text("source").$type<GoatManagedCapabilitySource>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedByWorkosId: text("updated_by_workos_id").references(() => goatUsers.workosUserId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.source] }),
    sourceCheck: check(
      "goat_workspace_capabilities_source_check",
      sql`${table.source} IN ('x', 'linkedin', 'youtube', 'instagram', 'tiktok', 'lead', 'seo')`,
    ),
  }),
);

// The wallet remains the usage ledger on every plan. This row also projects
// the Stripe seat subscription. stripe_product_key distinguishes it from
// retired v3 seat subscriptions; seat_quantity is the current billable seat
// count, and included_usage_period_* defines the non-rollover usage grant.
export const goatWorkspaceBilling = goat.table(
  "workspace_billing",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => goatWorkspaces.id, { onDelete: "cascade" }),
    plan: text("plan").$type<GoatWorkspacePlan>().notNull().default("free"),
    planStartedAt: timestamp("plan_started_at", { withTimezone: true }).notNull().defaultNow(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripeSubscriptionItemId: text("stripe_subscription_item_id"),
    stripePriceId: text("stripe_price_id"),
    stripeProductKey: text("stripe_product_key"),
    subscriptionStatus: text("subscription_status").$type<GoatStripeSubscriptionStatus>(),
    seatQuantity: integer("seat_quantity").notNull().default(1),
    includedUsagePeriodStart: timestamp("included_usage_period_start", { withTimezone: true }),
    includedUsagePeriodEnd: timestamp("included_usage_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    paymentNeedsAttention: boolean("payment_needs_attention").notNull().default(false),
    lastStripeEventCreated: timestamp("last_stripe_event_created", { withTimezone: true }),
    lastStripeInvoiceEventCreated: timestamp("last_stripe_invoice_event_created", {
      withTimezone: true,
    }),
    // Auto-refill: card saved during top-up Checkout, charged off-session when
    // the balance drops below the threshold. in_flight_at is a lease so
    // concurrent triggers charge at most once.
    autoRefillEnabled: boolean("auto_refill_enabled").notNull().default(false),
    autoRefillAmountCents: integer("auto_refill_amount_cents").notNull().default(2000),
    autoRefillPaymentMethodId: text("auto_refill_payment_method_id"),
    autoRefillInFlightAt: timestamp("auto_refill_in_flight_at", { withTimezone: true }),
    autoRefillLastAttemptAt: timestamp("auto_refill_last_attempt_at", { withTimezone: true }),
    autoRefillLastError: text("auto_refill_last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    customerIdx: uniqueIndex("goat_workspace_billing_customer_idx").on(table.stripeCustomerId),
    subscriptionIdx: uniqueIndex("goat_workspace_billing_subscription_idx").on(
      table.stripeSubscriptionId,
    ),
    planCheck: check("goat_workspace_billing_plan_check", sql`${table.plan} IN ('free', 'pro')`),
    seatQuantityCheck: check(
      "goat_workspace_billing_seat_quantity_check",
      sql`${table.seatQuantity} >= 1`,
    ),
    subscriptionStatusCheck: check(
      "goat_workspace_billing_subscription_status_check",
      sql`${table.subscriptionStatus} IS NULL OR ${table.subscriptionStatus} IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')`,
    ),
  }),
);

export const goatStripeWebhookEvents = goat.table("stripe_webhook_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  eventCreatedAt: timestamp("event_created_at", { withTimezone: true }).notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

// USD credit balance per workspace. balance_usd_micros remains the aggregate
// used by gates and dashboards; billing v6 also tracks the included seat pool
// separately from overage/top-up funds so debits can draw included usage first
// and expire unused included usage monthly without touching top-ups.
export const goatCreditBalances = goat.table("credit_balances", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => goatWorkspaces.id, { onDelete: "cascade" }),
  balanceCents: integer("balance_cents").notNull().default(0),
  balanceUsdMicros: bigint("balance_usd_micros", { mode: "number" }).notNull().default(0),
  includedBalanceUsdMicros: bigint("included_balance_usd_micros", { mode: "number" })
    .notNull()
    .default(0),
  topUpBalanceUsdMicros: bigint("top_up_balance_usd_micros", { mode: "number" })
    .notNull()
    .default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// One-time credit top-up Checkout sessions. `fulfilled_at IS NULL` is the
// webhook-fulfillment idempotency guard.
export const goatStripeCheckoutSessions = goat.table(
  "stripe_checkout_sessions",
  {
    id: text("id").primaryKey(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => goatWorkspaces.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id").references(() => goatUsers.workosUserId, {
      onDelete: "set null",
    }),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").$type<GoatCheckoutSessionStatus>().notNull().default("pending"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
  },
  (table) => ({
    stripeIdIdx: uniqueIndex("goat_stripe_checkout_sessions_stripe_id_idx").on(
      table.stripeCheckoutSessionId,
    ),
    workspaceIdx: index("goat_stripe_checkout_sessions_workspace_idx").on(table.workspaceId),
    statusCheck: check(
      "goat_stripe_checkout_sessions_status_check",
      sql`${table.status} IN ('pending', 'open', 'fulfilled', 'failed')`,
    ),
  }),
);

// Signed credit movements (positive = top-up/grant, negative = usage debit).
// One generic idempotency_key dedupes every surface (chat turn, frontier
// ingest attempt, overage reservation, top-up fulfillment); the typed
// reference columns exist for reporting only.
export const goatCreditLedger = goat.table(
  "credit_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => goatWorkspaces.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id").references(() => goatUsers.workosUserId, {
      onDelete: "set null",
    }),
    amountCents: integer("amount_cents").notNull(),
    amountUsdMicros: bigint("amount_usd_micros", { mode: "number" }).notNull().default(0),
    source: text("source").$type<GoatCreditLedgerSource>().notNull(),
    idempotencyKey: text("idempotency_key"),
    checkoutSessionId: text("checkout_session_id").references(() => goatStripeCheckoutSessions.id, {
      onDelete: "set null",
    }),
    chatSessionId: text("chat_session_id").references(() => goatChatSessions.id, {
      onDelete: "set null",
    }),
    ingestJobId: text("ingest_job_id").references(() => goatBrainIngestJobs.id, {
      onDelete: "set null",
    }),
    reservationId: text("reservation_id").references(() => goatWorkspaceIngestionReservations.id, {
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
    workspaceCreatedIdx: index("goat_credit_ledger_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    idempotencyIdx: uniqueIndex("goat_credit_ledger_idempotency_idx")
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    starterGrantIdx: uniqueIndex("goat_credit_ledger_starter_grant_idx")
      .on(table.workspaceId)
      .where(sql`${table.source} = 'starter_grant'`),
    sourceCheck: check(
      "goat_credit_ledger_source_check",
      sql`${table.source} IN ('starter_grant', 'seat_included_grant', 'seat_included_expiration', 'stripe_topup', 'chat_model_usage', 'capability_usage', 'frontier_ingest', 'ingest_overage', 'ingest_model_usage', 'ingest_fee', 'adjustment')`,
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
    // When true, the ingestion agent may use web search to enrich confidently
    // identified people, companies, and projects. Owner escape-hatch; the real
    // safety is the identity gate + per-ingest search cap in the runner.
    enrichmentEnabled: boolean("enrichment_enabled").notNull().default(true),
    // Which model tier the ingestion agent runs for this brain. "basic"
    // (open-source model) is included in the plan; "frontier" (Claude Sonnet)
    // passes model cost through to the workspace's credit balance.
    intelligence: text("intelligence").$type<GoatBrainIntelligence>().notNull().default("basic"),
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
    intelligenceCheck: check(
      "goat_brains_intelligence_check",
      sql`${table.intelligence} IN ('basic', 'frontier')`,
    ),
  }),
);

export const goatBrainImportRuns = goat.table(
  "brain_import_runs",
  {
    id: text("id").primaryKey(),
    brainRef: text("brain_ref")
      .notNull()
      .references(() => goatBrains.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    companyUrl: text("company_url").notNull(),
    companyDomain: text("company_domain").notNull(),
    companyName: text("company_name"),
    focus: text("focus"),
    historyStartAt: timestamp("history_start_at", {
      withTimezone: true,
    }).notNull(),
    historyEndAt: timestamp("history_end_at", { withTimezone: true }).notNull(),
    sourceSelection: jsonb("source_selection")
      .$type<GoatBrainImportSourceSelection>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    discoverySummary: jsonb("discovery_summary")
      .$type<GoatBrainImportDiscoverySummary>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    status: text("status").$type<GoatBrainImportStatus>().notNull().default("discovering"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull().defaultNow(),
    leaseId: text("lease_id"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activeBrainIdx: uniqueIndex("goat_brain_import_runs_active_brain_idx")
      .on(table.brainRef)
      .where(
        sql`${table.status} IN ('discovering', 'awaiting_confirmation', 'ingesting', 'finalizing')`,
      ),
    statusNextRunIdx: index("goat_brain_import_runs_status_next_run_idx").on(
      table.status,
      table.nextRunAt,
    ),
    leaseExpiresAtIdx: index("goat_brain_import_runs_lease_expires_at_idx").on(
      table.leaseExpiresAt,
    ),
    brainCreatedIdx: index("goat_brain_import_runs_brain_created_idx").on(
      table.brainRef,
      table.createdAt,
    ),
    statusCheck: check(
      "goat_brain_import_runs_status_check",
      sql`${table.status} IN ('discovering', 'awaiting_confirmation', 'ingesting', 'finalizing', 'succeeded', 'partial', 'failed', 'canceled')`,
    ),
    historyWindowCheck: check(
      "goat_brain_import_runs_history_window_check",
      sql`${table.historyStartAt} < ${table.historyEndAt}`,
    ),
  }),
);

export const goatBrainMembers = goat.table(
  "brain_members",
  {
    id: text("id").primaryKey(),
    brainId: text("brain_id")
      .notNull()
      .references(() => goatBrains.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
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
      .references(() => goatBrains.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
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
    // Who originally put this document in the brain (set once at insert, never
    // on update — unlike userWorkosId, which tracks the last actor). Null when
    // no human originated it, e.g. Slack-window ingestion: the integration
    // owner connected the channel but did not author its content.
    createdByWorkosId: text("created_by_workos_id").references(() => goatUsers.workosUserId, {
      onDelete: "set null",
    }),
    brainRef: text("brain_ref")
      .notNull()
      .references(() => goatBrains.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
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
    // Retrieval projections: `search_text` (title + aliases + compiled truth + timeline + relation
    // text) feeds the generated FTS vector; `name_text` (title + aliases) feeds trigram entity
    // lookup. Both are composed in documentValues() (goat-brain-files.ts).
    searchText: text("search_text").notNull().default(""),
    nameText: text("name_text").notNull().default(""),
    // asset_extracted_text is folded in directly (not via search_text) so PDF/DOCX extraction
    // updates — which touch only that column — reindex without recomposing search_text.
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('english', coalesce("search_text", '') || ' ' || coalesce("asset_extracted_text", ''))`,
    ),
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
    // Retrieval: keyword relevance (FTS) and typo/fuzzy entity lookup (trigram) — both GIN.
    searchTsvIdx: index("goat_brain_documents_search_tsv_idx").using("gin", table.searchTsv),
    nameTrgmIdx: index("goat_brain_documents_name_trgm_idx").using(
      "gin",
      table.nameText.op("gin_trgm_ops"),
    ),
    formatCheck: check(
      "goat_brain_documents_format_check",
      sql`${table.format} IN ('markdown', 'pdf', 'docx', 'xlsx', 'srt', 'image')`,
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
      .references(() => goatBrains.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
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
      .references(() => goatBrains.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
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

// One embedding per document over its retrieval text. `content_hash` mirrors the document's
// content_hash at embed time and `model` records the embedding model, so staleness is a plain SQL
// join predicate (e.content_hash = d.content_hash AND e.model = $model); stale or missing rows are
// re-embedded write-through at query time (goat-brain-read.ts). Rebuildable projection — safe to
// truncate.
export const goatBrainDocumentEmbeddings = goat.table(
  "brain_document_embeddings",
  {
    documentId: text("document_id")
      .primaryKey()
      .references(() => goatBrainDocuments.id, { onDelete: "cascade" }),
    brainRef: text("brain_ref")
      .notNull()
      .references(() => goatBrains.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    contentHash: text("content_hash").notNull(),
    model: text("model").notNull(),
    embedding: vector("embedding").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    brainRefIdx: index("goat_brain_document_embeddings_brain_ref_idx").on(table.brainRef),
  }),
);

export const goatBrainDocumentVersions = goat.table(
  "brain_document_versions",
  {
    id: serial("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    brainRef: text("brain_ref").references(() => goatBrains.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    documentId: text("document_id").references(() => goatBrainDocuments.id, {
      onDelete: "set null",
    }),
    taskId: text("task_id"),
    importRunId: text("import_run_id").references(() => goatBrainImportRuns.id, {
      onDelete: "set null",
    }),
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
    importRunCreatedIdx: index("goat_brain_document_versions_import_run_created_idx").on(
      table.importRunId,
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
    // The user who connected this integration. For personal integrations this
    // is the owner; for workspace-owned rows it is attribution only (the
    // credential AAD is also keyed on it, so it stays set either way).
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    // Set for workspace-owned integrations (installation-bound providers:
    // GitHub, Jamie, Slack bot, Stripe). NULL = personal integration owned by
    // user_workos_id.
    workspaceId: text("workspace_id").references(() => goatWorkspaces.id, {
      onDelete: "cascade",
    }),
    // Foundation for offering a personal integration to workspace admins as a
    // brain-source option without transferring ownership. No UI yet.
    sharedWithWorkspace: boolean("shared_with_workspace").notNull().default(false),
    provider: text("provider").$type<GoatIntegrationProvider>().notNull(),
    externalId: text("external_id").notNull(),
    connectionLabel: text("connection_label"),
    accountName: text("account_name"),
    accountEmail: text("account_email"),
    accountType: text("account_type"),
    status: text("status").$type<GoatIntegrationStatus>().notNull().default("connected"),
    statusReason: text("status_reason"),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // Sparse per-connection capability mode overrides (capability id → "on" |
    // "off" | "ask"). Missing keys fall back to the app-level capability
    // registry defaults, so defaults can evolve without a backfill.
    capabilityModes: jsonb("capability_modes")
      .$type<Partial<Record<string, "on" | "off" | "ask">>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userProviderIdx: index("goat_integrations_user_provider_idx").on(
      table.userWorkosId,
      table.provider,
    ),
    // One personal connection per external account per user. Partial so a
    // workspace-owned row never blocks (or gets matched by) personal upserts —
    // workspace rows are constrained by the workspace index below instead.
    userProviderExternalIdx: uniqueIndex("goat_integrations_user_provider_external_idx")
      .on(table.userWorkosId, table.provider, table.externalId)
      .where(sql`${table.workspaceId} IS NULL`),
    integrationUserProviderIdx: uniqueIndex("goat_integrations_id_user_provider_idx").on(
      table.id,
      table.userWorkosId,
      table.provider,
    ),
    providerExternalIdx: index("goat_integrations_provider_external_idx").on(
      table.provider,
      table.externalId,
    ),
    // One connection per external account per workspace, regardless of which
    // admin connected it.
    workspaceProviderExternalIdx: uniqueIndex("goat_integrations_workspace_provider_external_idx")
      .on(table.workspaceId, table.provider, table.externalId)
      .where(sql`${table.workspaceId} IS NOT NULL`),
    // The answer bot is a single workspace-level destination. Reinstalling it
    // for another Slack team updates the existing row so its brain routes stay
    // manageable instead of leaving a hidden installation active.
    slackBotWorkspaceIdx: uniqueIndex("goat_integrations_slack_bot_workspace_idx")
      .on(table.workspaceId, table.provider)
      .where(sql`${table.workspaceId} IS NOT NULL AND ${table.provider} = 'slack_bot'`),
    // Stripe credentials represent the workspace's single reporting account.
    // Rotating a key or switching accounts updates that row instead of leaving
    // another financial connection silently active.
    stripeWorkspaceIdx: uniqueIndex("goat_integrations_stripe_workspace_idx")
      .on(table.workspaceId, table.provider)
      .where(sql`${table.workspaceId} IS NOT NULL AND ${table.provider} = 'stripe'`),
    workspaceProviderIdx: index("goat_integrations_workspace_provider_idx").on(
      table.workspaceId,
      table.provider,
    ),
    providerCheck: check(
      "goat_integrations_provider_check",
      sql`${table.provider} IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude', 'posthog', 'neon', 'imessage')`,
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
      sql`${table.provider} IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude', 'posthog', 'neon', 'imessage')`,
    ),
    kindCheck: check(
      "goat_integration_credentials_kind_check",
      sql`${table.kind} IN ('oauth_token', 'webhook_secret', 'api_key')`,
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
      sql`${table.provider} IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude', 'posthog', 'neon', 'imessage')`,
    ),
    statusCheck: check(
      "goat_integration_resources_status_check",
      sql`${table.status} IN ('available', 'permission_lost', 'archived', 'sync_failed')`,
    ),
  }),
);

// Pending iMessage pairing verification. One active challenge per user,
// upserted on resend. Lives outside the Electric-synced integrations table so
// the code hash never reaches clients.
export const goatImessagePairingChallenges = goat.table(
  "imessage_pairing_challenges",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    phoneE164: text("phone_e164").notNull(),
    // sha256 hex of the 6-digit code; the plaintext is only ever in the sent message.
    codeHash: text("code_hash").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: uniqueIndex("goat_imessage_pairing_challenges_user_idx").on(table.userWorkosId),
  }),
);

// Audit log of outbound iMessages; doubles as the per-user daily rate-limit
// counter for the send_user_message tool.
export const goatImessageSends = goat.table(
  "imessage_sends",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    source: text("source").$type<GoatImessageSendSource>().notNull(),
    chatSessionId: text("chat_session_id"),
    turnId: text("turn_id"),
    status: text("status").$type<GoatImessageSendStatus>().notNull(),
    errorReason: text("error_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index("goat_imessage_sends_user_created_idx").on(
      table.userWorkosId,
      table.createdAt,
    ),
    turnSentIdx: uniqueIndex("goat_imessage_sends_turn_sent_idx")
      .on(table.turnId)
      .where(sql`${table.turnId} IS NOT NULL AND ${table.status} = 'sent'`),
    sourceCheck: check(
      "goat_imessage_sends_source_check",
      sql`${table.source} IN ('chat', 'task', 'pairing')`,
    ),
    statusCheck: check(
      "goat_imessage_sends_status_check",
      sql`${table.status} IN ('sent', 'failed')`,
    ),
  }),
);

// Per-brain source configuration: which integration feeds which brain.
export const goatBrainSources = goat.table(
  "brain_sources",
  {
    id: text("id").primaryKey(),
    brainId: text("brain_id")
      .notNull()
      .references(() => goatBrains.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    provider: text("provider").$type<GoatBrainSourceConfigProvider>().notNull(),
    integrationId: text("integration_id").notNull(),
    // user_workos_id of the referenced integration row (its owner for personal
    // integrations, the connecting admin for workspace-owned ones). Part of the
    // composite FK below, so it must mirror the integration row exactly.
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
      sql`${table.provider} IN ('jamie', 'gmail', 'google_drive', 'github', 'slack', 'linear', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio')`,
    ),
  }),
);

// Cross-member ingest dedup: a claim records that a brain has already ingested
// a provider-native event (Slack team:channel:ts, Gmail RFC822 Message-ID,
// Linear org:issue:delivery), regardless of which member's integration
// delivered it. Flush workers only enqueue an ingest job for a brain when at
// least one event in the window is newly claimed. source_item_id is SET NULL
// so the dedup guarantee outlives the raw evidence row.
export const goatBrainSourceEventClaims = goat.table(
  "brain_source_event_claims",
  {
    id: text("id").primaryKey(),
    brainId: text("brain_id")
      .notNull()
      .references(() => goatBrains.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    sourceProvider: text("source_provider").notNull(),
    eventKey: text("event_key").notNull(),
    sourceItemId: text("source_item_id").references(() => goatBrainSourceItems.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    brainProviderKeyIdx: uniqueIndex("goat_brain_source_event_claims_brain_provider_key_idx").on(
      table.brainId,
      table.sourceProvider,
      table.eventKey,
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
    // Number of selected provider events represented by this normalized item.
    // Direct webhooks, captures, and uploads are one; buffered windows pass the
    // exact number of claimed source rows.
    rawEventCount: integer("raw_event_count").notNull().default(1),
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
      sql`${table.sourceProvider} IN ('jamie', 'goat-chat', 'goat-import', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive', 'hubspot', 'granola', 'fathom', 'attio')`,
    ),
    sourceTypeCheck: check(
      "goat_brain_source_items_source_type_check",
      sql`${table.sourceType} IN ('meeting', 'run', 'capture', 'pointer', 'asset', 'conversation', 'issue', 'activity', 'thread', 'document')`,
    ),
    lastIngestStatusCheck: check(
      "goat_brain_source_items_last_ingest_status_check",
      sql`${table.lastIngestStatus} IS NULL OR ${table.lastIngestStatus} IN ('pending', 'succeeded', 'failed', 'skipped')`,
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
    workspaceId: text("workspace_id").references(() => goatWorkspaces.id, {
      onDelete: "cascade",
    }),
    importRunId: text("import_run_id").references(() => goatBrainImportRuns.id, {
      onDelete: "set null",
    }),
    // Target brain for the job (principle: ingestion is per-brain). Null means
    // the handler resolves the user's default brain at run time.
    brainRef: text("brain_ref").references(() => goatBrains.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    kind: text("kind").$type<GoatBrainIngestJobKind>().notNull(),
    contentHash: text("content_hash").notNull(),
    status: text("status").$type<GoatBrainIngestJobStatus>().notNull().default("queued"),
    planPaused: boolean("plan_paused").notNull().default(false),
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
    workspaceCreatedIdx: index("goat_brain_ingest_jobs_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    importRunIdx: index("goat_brain_ingest_jobs_import_run_idx").on(table.importRunId),
    sourceProviderCheck: check(
      "goat_brain_ingest_jobs_source_provider_check",
      sql`${table.sourceProvider} IN ('jamie', 'goat-chat', 'goat-import', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive', 'hubspot', 'granola', 'fathom', 'attio')`,
    ),
    kindCheck: check(
      "goat_brain_ingest_jobs_kind_check",
      sql`${table.kind} IN ('brain_source_item_ingest', 'brain_agent_ingest', 'brain_pointer_hydrate')`,
    ),
    statusCheck: check(
      "goat_brain_ingest_jobs_status_check",
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'skipped')`,
    ),
  }),
);

// One reservation per normalized source item and workspace. Fan-out to several
// brains in the same workspace therefore consumes the raw events exactly once.
export const goatWorkspaceIngestionReservations = goat.table(
  "workspace_ingestion_reservations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => goatWorkspaces.id, { onDelete: "cascade" }),
    sourceItemId: text("source_item_id")
      .notNull()
      .references(() => goatBrainSourceItems.id, { onDelete: "cascade" }),
    sourceProvider: text("source_provider").$type<GoatBrainSourceProvider>().notNull(),
    rawEventCount: integer("raw_event_count").notNull(),
    status: text("status").$type<GoatIngestionReservationStatus>().notNull().default("pending"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    // > 0 when part or all of the reservation was admitted by debiting credits
    // (Pro overage, $2 per 100 raw events) beyond the monthly allowance.
    billedOverageRawEventCount: integer("billed_overage_raw_event_count").notNull().default(0),
    billedOverageUsdMicros: bigint("billed_overage_usd_micros", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceSourceIdx: uniqueIndex("goat_ingestion_reservations_workspace_source_idx").on(
      table.workspaceId,
      table.sourceItemId,
    ),
    workspaceStatusCreatedIdx: index("goat_ingestion_reservations_status_created_idx").on(
      table.workspaceId,
      table.status,
      table.createdAt,
    ),
    // The backlog-release sweep filters on status alone; this stays near-empty
    // because pending rows are transient, while the table itself only grows.
    pendingWorkspaceIdx: index("goat_ingestion_reservations_pending_idx")
      .on(table.workspaceId)
      .where(sql`${table.status} = 'pending'`),
    workspaceConsumedIdx: index("goat_ingestion_reservations_consumed_idx").on(
      table.workspaceId,
      table.consumedAt,
    ),
    statusCheck: check(
      "goat_ingestion_reservations_status_check",
      sql`${table.status} IN ('pending', 'consumed')`,
    ),
    rawEventCountCheck: check(
      "goat_ingestion_reservations_raw_event_count_check",
      sql`${table.rawEventCount} > 0 AND ${table.rawEventCount} <= 200`,
    ),
    billedOverageRawEventCountCheck: check(
      "goat_ingestion_reservations_billed_overage_units_check",
      sql`${table.billedOverageRawEventCount} >= 0 AND ${table.billedOverageRawEventCount} <= ${table.rawEventCount}`,
    ),
    billedOverageUsdMicrosCheck: check(
      "goat_ingestion_reservations_billed_overage_usd_check",
      sql`${table.billedOverageUsdMicros} >= 0`,
    ),
    sourceProviderCheck: check(
      "goat_ingestion_reservations_source_provider_check",
      sql`${table.sourceProvider} IN ('jamie', 'goat-chat', 'goat-import', 'upload', 'slack', 'linear', 'github', 'gmail', 'google_drive', 'hubspot', 'granola', 'fathom', 'attio')`,
    ),
    consumptionStateCheck: check(
      "goat_ingestion_reservations_consumption_state_check",
      sql`(${table.status} = 'consumed' AND ${table.consumedAt} IS NOT NULL) OR (${table.status} = 'pending' AND ${table.consumedAt} IS NULL)`,
    ),
  }),
);

export const goatBrainImportCandidates = goat.table(
  "brain_import_candidates",
  {
    id: text("id").primaryKey(),
    importRunId: text("import_run_id")
      .notNull()
      .references(() => goatBrainImportRuns.id, { onDelete: "cascade" }),
    provider: text("provider").$type<GoatBrainImportProvider>().notNull(),
    sourceItemId: text("source_item_id")
      .notNull()
      .references(() => goatBrainSourceItems.id, { onDelete: "cascade" }),
    ingestJobId: text("ingest_job_id").references(() => goatBrainIngestJobs.id, {
      onDelete: "set null",
    }),
    entryCount: integer("entry_count").notNull().default(1),
    rank: integer("rank").notNull().default(0),
    selected: boolean("selected").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runSourceIdx: uniqueIndex("goat_brain_import_candidates_run_source_idx").on(
      table.importRunId,
      table.sourceItemId,
    ),
    runProviderRankIdx: index("goat_brain_import_candidates_run_provider_rank_idx").on(
      table.importRunId,
      table.provider,
      table.rank,
    ),
    providerCheck: check(
      "goat_brain_import_candidates_provider_check",
      sql`${table.provider} IN ('public_web', 'github', 'jamie', 'granola', 'fathom', 'gmail', 'slack', 'linear')`,
    ),
  }),
);

// Durable delivery lease for Slack answer-bot events. Slack can retry a failed
// HTTP delivery while the original after() task is still running, so event_id
// is claimed before scheduling work and can be reclaimed only after the task's
// maximum runtime has elapsed.
export const goatSlackBotEventClaims = goat.table("slack_bot_event_claims", {
  eventId: text("event_id").primaryKey(),
  teamId: text("team_id").notNull(),
  claimId: text("claim_id").notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Threads the answer bot has replied in. Lets the message-event webhook decide
// with one indexed lookup whether a reply-without-mention should get an answer,
// instead of calling conversations.replies for every threaded message in every
// channel the bot is in. Rows are upserted on each bot reply and pruned after
// ~30 days of thread inactivity.
export const goatSlackBotThreadParticipation = goat.table(
  "slack_bot_thread_participation",
  {
    teamId: text("team_id").notNull(),
    channelId: text("channel_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => goatIntegrations.id, { onDelete: "cascade" }),
    lastBotReplyTs: text("last_bot_reply_ts").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "slack_bot_thread_participation_pkey",
      columns: [table.teamId, table.channelId, table.threadTs],
    }),
    updatedAtIdx: index("goat_sbtp_updated_at_idx").on(table.updatedAt),
  }),
);

// Raw Slack message buffer: the events webhook inserts one row per relevant
// message; the runner's flush sweeper batches unflushed rows per channel into a
// conversation-window source item after a quiet period (source_item_id NULL =
// unflushed).
export const goatSlackMessageEvents = goat.table(
  "slack_message_events",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => goatIntegrations.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    channelId: text("channel_id").notNull(),
    channelType: text("channel_type").$type<GoatSlackChannelType>().notNull(),
    messageTs: text("message_ts").notNull(),
    threadTs: text("thread_ts"),
    slackUserId: text("slack_user_id"),
    subtype: text("subtype"),
    text: text("text").notNull().default(""),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    sourceItemId: text("source_item_id").references(() => goatBrainSourceItems.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Slack redelivers events on retry; ts is unique per channel.
    integrationChannelTsIdx: uniqueIndex("goat_slack_message_events_integration_channel_ts_idx").on(
      table.integrationId,
      table.channelId,
      table.messageTs,
    ),
    pendingIdx: index("goat_slack_message_events_pending_idx")
      .on(table.integrationId, table.channelId, table.receivedAt)
      .where(sql`${table.sourceItemId} IS NULL`),
    sourceItemIdx: index("goat_slack_message_events_source_item_idx").on(table.sourceItemId),
    channelTypeCheck: check(
      "goat_slack_message_events_channel_type_check",
      sql`${table.channelType} IN ('channel', 'group', 'im', 'mpim')`,
    ),
  }),
);

// Raw Linear activity buffer: the webhook inserts one row per relevant issue or
// comment event; the runner's flush sweeper batches unflushed rows per issue
// into an issue-window source item after a quiet period (source_item_id NULL =
// unflushed).
export const goatLinearIssueEvents = goat.table(
  "linear_issue_events",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => goatIntegrations.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    // Nullable: comment events do not always carry the issue's team; the flush
    // worker re-resolves the team from the live issue snapshot.
    teamId: text("team_id"),
    issueId: text("issue_id").notNull(),
    // One webhook delivery may buffer for several integrations of the same
    // Linear organization; the delivery id makes redeliveries per-integration no-ops.
    deliveryId: text("delivery_id").notNull(),
    entityType: text("entity_type").$type<GoatLinearEventEntityType>().notNull(),
    action: text("action").$type<GoatLinearEventAction>().notNull(),
    issueTitle: text("issue_title"),
    actorName: text("actor_name"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    sourceItemId: text("source_item_id").references(() => goatBrainSourceItems.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    integrationDeliveryIdx: uniqueIndex("goat_linear_issue_events_integration_delivery_idx").on(
      table.integrationId,
      table.deliveryId,
    ),
    pendingIdx: index("goat_linear_issue_events_pending_idx")
      .on(table.integrationId, table.issueId, table.receivedAt)
      .where(sql`${table.sourceItemId} IS NULL`),
    sourceItemIdx: index("goat_linear_issue_events_source_item_idx").on(table.sourceItemId),
    entityTypeCheck: check(
      "goat_linear_issue_events_entity_type_check",
      sql`${table.entityType} IN ('issue', 'comment')`,
    ),
    actionCheck: check(
      "goat_linear_issue_events_action_check",
      sql`${table.action} IN ('create', 'update', 'remove')`,
    ),
  }),
);

// Raw GitHub pull-request activity buffer: the webhook inserts one row per
// opened, commented, or merged event; the runner's flush sweeper batches
// unflushed rows per pull request into one activity-window source item after a
// quiet period (source_item_id NULL = unflushed). Issue activity remains
// direct-enqueue because it does not have the open-to-merge lifecycle that
// causes repeated PR ingestion.
export const goatGitHubPullRequestEvents = goat.table(
  "github_pull_request_events",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => goatIntegrations.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    pullRequestNumber: integer("pull_request_number").notNull(),
    // GitHub's X-GitHub-Delivery UUID is stable across redelivery attempts.
    deliveryId: text("delivery_id").notNull(),
    eventType: text("event_type").$type<GoatGitHubPullRequestEventType>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    sourceItemId: text("source_item_id").references(() => goatBrainSourceItems.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    integrationDeliveryIdx: uniqueIndex(
      "goat_github_pull_request_events_integration_delivery_idx",
    ).on(table.integrationId, table.deliveryId),
    pendingIdx: index("goat_github_pull_request_events_pending_idx")
      .on(table.integrationId, table.repositoryId, table.pullRequestNumber, table.receivedAt)
      .where(sql`${table.sourceItemId} IS NULL`),
    sourceItemIdx: index("goat_github_pull_request_events_source_item_idx").on(table.sourceItemId),
    eventTypeCheck: check(
      "goat_github_pull_request_events_event_type_check",
      sql`${table.eventType} IN ('pull_request_opened', 'pull_request_merged', 'pull_request_commented')`,
    ),
  }),
);

// Raw HubSpot CRM activity buffer: the webhook inserts one row per relevant
// object event (creation or property change); the runner's flush sweeper
// batches unflushed rows per CRM object into an object-window source item
// after a quiet period (source_item_id NULL = unflushed).
export const goatHubspotObjectEvents = goat.table(
  "hubspot_object_events",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => goatIntegrations.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    portalId: text("portal_id").notNull(),
    objectType: text("object_type").$type<GoatHubspotObjectType>().notNull(),
    objectId: text("object_id").notNull(),
    // One webhook delivery may buffer for several integrations of the same
    // HubSpot portal; the event id makes redeliveries per-integration no-ops.
    deliveryId: text("delivery_id").notNull(),
    action: text("action").$type<GoatHubspotEventAction>().notNull(),
    // Set for property-change events; flush classification reads it without
    // re-parsing the payload.
    propertyName: text("property_name"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    sourceItemId: text("source_item_id").references(() => goatBrainSourceItems.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    integrationDeliveryIdx: uniqueIndex("goat_hubspot_object_events_integration_delivery_idx").on(
      table.integrationId,
      table.deliveryId,
    ),
    pendingIdx: index("goat_hubspot_object_events_pending_idx")
      .on(table.integrationId, table.objectType, table.objectId, table.receivedAt)
      .where(sql`${table.sourceItemId} IS NULL`),
    sourceItemIdx: index("goat_hubspot_object_events_source_item_idx").on(table.sourceItemId),
    objectTypeCheck: check(
      "goat_hubspot_object_events_object_type_check",
      sql`${table.objectType} IN ('contact', 'company', 'deal')`,
    ),
    actionCheck: check(
      "goat_hubspot_object_events_action_check",
      sql`${table.action} IN ('create', 'update')`,
    ),
  }),
);

// Raw Attio CRM activity buffer: the webhook inserts one row per relevant
// record event (creation, attribute change, or note added); the runner's flush
// sweeper batches unflushed rows per record into an object-window source item
// after a quiet period (source_item_id NULL = unflushed).
export const goatAttioObjectEvents = goat.table(
  "attio_object_events",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => goatIntegrations.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    objectType: text("object_type").$type<GoatAttioObjectType>().notNull(),
    recordId: text("record_id").notNull(),
    // Attio deliveries carry no delivery id; the receiver synthesizes one that
    // is stable for note/create events so redeliveries are per-integration
    // no-ops (update events coalesce in the window instead).
    deliveryId: text("delivery_id").notNull(),
    action: text("action").$type<GoatAttioEventAction>().notNull(),
    // Set for attribute-change events; flush enrichment resolves the attribute
    // name without re-parsing the payload.
    attributeId: text("attribute_id"),
    // Set for note.created events; the flush worker fetches note content.
    noteId: text("note_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    sourceItemId: text("source_item_id").references(() => goatBrainSourceItems.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    integrationDeliveryIdx: uniqueIndex("goat_attio_object_events_integration_delivery_idx").on(
      table.integrationId,
      table.deliveryId,
    ),
    pendingIdx: index("goat_attio_object_events_pending_idx")
      .on(table.integrationId, table.objectType, table.recordId, table.receivedAt)
      .where(sql`${table.sourceItemId} IS NULL`),
    sourceItemIdx: index("goat_attio_object_events_source_item_idx").on(table.sourceItemId),
    objectTypeCheck: check(
      "goat_attio_object_events_object_type_check",
      sql`${table.objectType} IN ('person', 'company', 'deal')`,
    ),
    actionCheck: check(
      "goat_attio_object_events_action_check",
      sql`${table.action} IN ('create', 'update', 'note')`,
    ),
  }),
);

// Raw Gmail message buffer: the runner's poll worker inserts one row per new
// message discovered via the Gmail history API; the flush sweeper batches
// unflushed rows per thread into a thread-window source item after a quiet
// period (source_item_id NULL = unflushed).
export const goatGmailMessageEvents = goat.table(
  "gmail_message_events",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => goatIntegrations.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    messageId: text("message_id").notNull(),
    // RFC822 Message-ID header — the only cross-mailbox identity for an email
    // (Gmail message ids are per-mailbox). Used for cross-member brain dedup;
    // NULL for rows buffered before capture shipped or when the header is absent.
    rfc822MessageId: text("rfc822_message_id"),
    // Classified at poll time from labelIds (SENT label); flush routing matches
    // brain-source event filters against this without re-parsing labels.
    direction: text("direction").$type<GoatGmailMessageDirection>().notNull(),
    subject: text("subject"),
    fromHeader: text("from_header"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    sourceItemId: text("source_item_id").references(() => goatBrainSourceItems.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // History polling can re-report a message across overlapping windows; the
    // unique (integration, message id) index makes re-discovery a no-op.
    integrationMessageIdx: uniqueIndex("goat_gmail_message_events_integration_message_idx").on(
      table.integrationId,
      table.messageId,
    ),
    pendingIdx: index("goat_gmail_message_events_pending_idx")
      .on(table.integrationId, table.threadId, table.receivedAt)
      .where(sql`${table.sourceItemId} IS NULL`),
    sourceItemIdx: index("goat_gmail_message_events_source_item_idx").on(table.sourceItemId),
    directionCheck: check(
      "goat_gmail_message_events_direction_check",
      sql`${table.direction} IN ('sent', 'received')`,
    ),
  }),
);

// Per-integration Gmail history cursor for the poll worker. history_id NULL =
// first poll pending (ingestion starts from the moment of connection, no
// backfill); last_reset_at records historyId-expiry resets for observability.
export const goatGmailSyncState = goat.table("gmail_sync_state", {
  integrationId: text("integration_id")
    .primaryKey()
    .references(() => goatIntegrations.id, { onDelete: "cascade" }),
  userWorkosId: text("user_workos_id")
    .notNull()
    .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
  emailAddress: text("email_address"),
  historyId: text("history_id"),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  lastResetAt: timestamp("last_reset_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-integration Granola poll cursor. Granola has no webhooks, so the runner
// polls GET /v1/notes with updated_after (notes surface in the API only once
// their AI summary and transcript are generated, which can be long after
// created_at). updated_after_cursor NULL = first poll pending; ingestion starts
// from the moment of connection, no backfill.
export const goatGranolaSyncState = goat.table("granola_sync_state", {
  integrationId: text("integration_id")
    .primaryKey()
    .references(() => goatIntegrations.id, { onDelete: "cascade" }),
  userWorkosId: text("user_workos_id")
    .notNull()
    .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
  updatedAfterCursor: timestamp("updated_after_cursor", { withTimezone: true }),
  pageCursor: text("page_cursor"),
  pendingUpdatedAfterCursor: timestamp("pending_updated_after_cursor", { withTimezone: true }),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-integration Fathom poll cursor. Goat uses bounded created_after /
// created_before windows for personal API-key connections. The initial cursor
// is written when the connection is created, so live ingestion never backfills
// implicitly. pending_created_before_cursor pins the upper bound while an
// opaque page_cursor continuation is in flight.
export const goatFathomSyncState = goat.table("fathom_sync_state", {
  integrationId: text("integration_id")
    .primaryKey()
    .references(() => goatIntegrations.id, { onDelete: "cascade" }),
  userWorkosId: text("user_workos_id")
    .notNull()
    .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
  createdAfterCursor: timestamp("created_after_cursor", { withTimezone: true }),
  pageCursor: text("page_cursor"),
  pendingCreatedBeforeCursor: timestamp("pending_created_before_cursor", { withTimezone: true }),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Fathom can list a recording before its generated summary or transcript is
// available. Keep those recordings durable while the timestamp cursor moves
// forward; the runner retries the recording content endpoints and only creates
// the cross-brain event claim once usable content exists.
export const goatFathomPendingMeetings = goat.table(
  "fathom_pending_meetings",
  {
    integrationId: text("integration_id")
      .notNull()
      .references(() => goatIntegrations.id, { onDelete: "cascade" }),
    recordingId: text("recording_id").notNull(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    meetingCreatedAt: timestamp("meeting_created_at", { withTimezone: true }).notNull(),
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>().notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "goat_fathom_pending_meetings_pk",
      columns: [table.integrationId, table.recordingId],
    }),
    retryIdx: index("goat_fathom_pending_meetings_retry_idx").on(
      table.integrationId,
      table.lastAttemptedAt.asc().nullsFirst(),
      table.createdAt,
    ),
  }),
);

// One durable Drive change-feed cursor per connected account/corpus. My Drive
// and directly shared files use corpus_key "user"; selected Shared Drives use
// "drive:<id>" because Google maintains a distinct change log for each drive.
export const goatGoogleDriveSyncCursors = goat.table(
  "google_drive_sync_cursors",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => goatIntegrations.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    corpusKey: text("corpus_key").notNull(),
    driveId: text("drive_id"),
    pageToken: text("page_token").notNull(),
    webhookAddress: text("webhook_address").notNull(),
    wakeRequestedAt: timestamp("wake_requested_at", { withTimezone: true }),
    leaseId: text("lease_id"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastSuccessfulAt: timestamp("last_successful_at", { withTimezone: true }),
    lastResetAt: timestamp("last_reset_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    integrationCorpusIdx: uniqueIndex("goat_google_drive_sync_cursors_integration_corpus_idx").on(
      table.integrationId,
      table.corpusKey,
    ),
    dueIdx: index("goat_google_drive_sync_cursors_due_idx").on(
      table.wakeRequestedAt,
      table.lastPolledAt,
    ),
    leaseIdx: index("goat_google_drive_sync_cursors_lease_idx").on(table.leaseExpiresAt),
  }),
);

// Drive watch renewal intentionally overlaps old and new channels. Keeping
// each channel lets the public webhook authenticate either one until expiry.
export const goatGoogleDriveWatchChannels = goat.table(
  "google_drive_watch_channels",
  {
    id: text("id").primaryKey(),
    cursorId: text("cursor_id")
      .notNull()
      .references(() => goatGoogleDriveSyncCursors.id, { onDelete: "cascade" }),
    integrationId: text("integration_id")
      .notNull()
      .references(() => goatIntegrations.id, { onDelete: "cascade" }),
    resourceId: text("resource_id"),
    tokenHash: text("token_hash").notNull(),
    status: text("status").$type<GoatGoogleDriveWatchChannelStatus>().notNull().default("creating"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    cursorExpiryIdx: index("goat_google_drive_watch_channels_cursor_expiry_idx").on(
      table.cursorId,
      table.status,
      table.expiresAt,
    ),
    statusCheck: check(
      "goat_google_drive_watch_channels_status_check",
      sql`${table.status} IN ('creating', 'active', 'stopped')`,
    ),
  }),
);

// A single coalescing row per Drive file. observed_version may advance while a
// leased ingest is running; completion only advances ingested_version to the
// exact fetched version, leaving any newer observation eligible for the next pass.
export const goatGoogleDriveFileStates = goat.table(
  "google_drive_file_states",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => goatIntegrations.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    fileId: text("file_id").notNull(),
    driveId: text("drive_id"),
    observedVersion: text("observed_version").notNull(),
    ingestedVersion: text("ingested_version"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    nextIngestAt: timestamp("next_ingest_at", { withTimezone: true }).notNull(),
    forceIngestAt: timestamp("force_ingest_at", { withTimezone: true }).notNull(),
    leaseId: text("lease_id"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    lastSourceItemId: text("last_source_item_id").references(() => goatBrainSourceItems.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    integrationFileIdx: uniqueIndex("goat_google_drive_file_states_integration_file_idx").on(
      table.integrationId,
      table.fileId,
    ),
    dueIdx: index("goat_google_drive_file_states_due_idx").on(
      table.nextIngestAt,
      table.forceIngestAt,
    ),
    leaseExpiryIdx: index("goat_google_drive_file_states_lease_expiry_idx").on(
      table.leaseExpiresAt,
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

// Workspace-scoped automations. Formerly stored as markdown documents in a
// reserved `workflows/` Brain folder; extracted here so "how work happens" is a
// first-class, company-level primitive rather than Brain (knowledge) content.
// `slug` is the stable handle used by the `#` composer mention and persisted as
// `tasks.workflow_id` when a workflow fires.
export const goatWorkflows = goat.table(
  "workflows",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => goatWorkspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    // Engine/model token from the editor's Model dropdown (e.g. "kimi-k2.6",
    // "codex"); empty when the workflow has not picked one explicitly.
    model: text("model").notNull().default(""),
    steps: jsonb("steps").$type<GoatWorkflowStep[]>().notNull().default(sql`'[]'::jsonb`),
    trigger: text("trigger").$type<GoatWorkflowTrigger>().notNull().default("manual"),
    scheduleCron: text("schedule_cron"),
    scheduleTimezone: text("schedule_timezone").notNull().default("UTC"),
    schedulePrompt: text("schedule_prompt").notNull().default(""),
    scheduleUserWorkosId: text("schedule_user_workos_id").references(() => goatUsers.workosUserId, {
      onDelete: "set null",
    }),
    scheduleHarnessSpec: jsonb("schedule_harness_spec").$type<GoatHarnessSpec | null>(),
    scheduleEnabled: boolean("schedule_enabled").notNull().default(false),
    scheduleLastRunAt: timestamp("schedule_last_run_at", { withTimezone: true }),
    scheduleNextRunAt: timestamp("schedule_next_run_at", { withTimezone: true }),
    status: text("status").$type<GoatWorkflowStatus>().notNull().default("active"),
    createdByWorkosId: text("created_by_workos_id").references(() => goatUsers.workosUserId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    // Slug is the mention handle; unique per workspace among live rows so an
    // archived workflow's slug can be reused.
    workspaceSlugIdx: uniqueIndex("goat_workflows_workspace_slug_idx")
      .on(table.workspaceId, table.slug)
      .where(sql`${table.archivedAt} IS NULL`),
    workspaceUpdatedIdx: index("goat_workflows_workspace_updated_idx").on(
      table.workspaceId,
      table.archivedAt,
      table.updatedAt,
    ),
    scheduleDueIdx: index("goat_workflows_schedule_due_idx")
      .on(table.scheduleEnabled, table.scheduleNextRunAt)
      .where(
        sql`${table.trigger} = 'schedule' AND ${table.status} = 'active' AND ${table.archivedAt} IS NULL`,
      ),
    statusCheck: check("goat_workflows_status_check", sql`${table.status} IN ('draft', 'active')`),
    triggerCheck: check(
      "goat_workflows_trigger_check",
      sql`${table.trigger} IN ('manual', 'slack', 'linear', 'schedule')`,
    ),
  }),
);

// Workspace-scoped, reusable agent capabilities. Formerly stored in a reserved
// `skills/` Brain folder; extracted alongside workflows. `slug` is the handle
// used by the `@skill/<slug>` composer mention. Attaching a skill to a chat
// still snapshots its content immutably into `goatChatSessionSkills`.
export const goatSkills = goat.table(
  "skills",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => goatWorkspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    status: text("status").$type<GoatSkillStatus>().notNull().default("draft"),
    createdByWorkosId: text("created_by_workos_id").references(() => goatUsers.workosUserId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    workspaceSlugIdx: uniqueIndex("goat_skills_workspace_slug_idx")
      .on(table.workspaceId, table.slug)
      .where(sql`${table.archivedAt} IS NULL`),
    workspaceUpdatedIdx: index("goat_skills_workspace_updated_idx").on(
      table.workspaceId,
      table.archivedAt,
      table.updatedAt,
    ),
    statusCheck: check("goat_skills_status_check", sql`${table.status} IN ('draft', 'active')`),
  }),
);

// Workspace-shared bootstrap material for repositories used by the repo-agnostic
// Codex and Claude Code chat sandboxes. Environment contents are encrypted at
// rest; envKeys is intentionally limited to plaintext key names for settings UI.
export const goatRepoConfigs = goat.table(
  "repo_configs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => goatWorkspaces.id, { onDelete: "cascade" }),
    repositoryExternalId: text("repository_external_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    encryptedEnvPayload: jsonb("encrypted_env_payload").$type<EncryptedPayload>(),
    encryptionKeyVersion: integer("encryption_key_version"),
    envKeys: jsonb("env_keys").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    setupInstructions: text("setup_instructions").notNull().default(""),
    createdByWorkosId: text("created_by_workos_id").references(() => goatUsers.workosUserId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceRepositoryIdx: uniqueIndex("goat_repo_configs_workspace_repository_idx").on(
      table.workspaceId,
      table.repositoryExternalId,
    ),
    envEncryptionCheck: check(
      "goat_repo_configs_env_encryption_check",
      sql`(${table.encryptedEnvPayload} IS NULL AND ${table.encryptionKeyVersion} IS NULL)
        OR (${table.encryptedEnvPayload} IS NOT NULL AND ${table.encryptionKeyVersion} IS NOT NULL)`,
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
    workspaceId: text("workspace_id").references(() => goatWorkspaces.id, {
      onDelete: "set null",
    }),
    prompt: text("prompt").notNull(),
    model: text("model").$type<AgentModelId>().notNull(),
    sessionId: text("session_id").references(() => goatChatSessions.id, {
      onDelete: "set null",
    }),
    scheduleId: text("schedule_id").references(() => goatTaskSchedules.id, {
      onDelete: "set null",
    }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    status: text("status").$type<GoatTaskStatus>().notNull().default("queued"),
    stage: text("stage").$type<GoatTaskStage>().notNull().default("queued"),
    result: text("result"),
    error: text("error"),
    workflowId: text("workflow_id"),
    workflowBrainRef: text("workflow_brain_ref"),
    reportedOutcome: text("reported_outcome").$type<GoatTaskReportedOutcome>(),
    outcomeComment: text("outcome_comment"),
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
    workspaceArchivedCreatedAtIdx: index("goat_tasks_workspace_archived_created_at_idx").on(
      table.workspaceId,
      table.archivedAt,
      table.createdAt,
    ),
    statusNextRunAtIdx: index("goat_tasks_status_next_run_at_idx").on(
      table.status,
      table.nextRunAt,
    ),
    leaseExpiresAtIdx: index("goat_tasks_lease_expires_at_idx").on(table.leaseExpiresAt),
    scheduleIdx: index("goat_tasks_schedule_idx").on(table.scheduleId, table.scheduledFor),
    sessionIdx: uniqueIndex("goat_tasks_session_idx")
      .on(table.sessionId)
      .where(sql`${table.sessionId} IS NOT NULL`),
    statusCheck: check(
      "goat_tasks_status_check",
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'canceled')`,
    ),
    stageCheck: check(
      "goat_tasks_stage_check",
      sql`${table.stage} IN ('queued', 'planning', 'sandboxing', 'running', 'completed', 'failed', 'canceled')`,
    ),
    reportedOutcomeCheck: check(
      "goat_tasks_reported_outcome_check",
      sql`${table.reportedOutcome} IS NULL OR ${table.reportedOutcome} IN ('done', 'needs_attention')`,
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
    taskId: text("task_id").references(() => goatTasks.id, {
      onDelete: "set null",
    }),
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

export const goatWorkflowScheduleRuns = goat.table(
  "workflow_schedule_runs",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => goatWorkflows.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => goatWorkspaces.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    taskId: text("task_id").references(() => goatTasks.id, {
      onDelete: "set null",
    }),
    status: text("status").$type<GoatTaskScheduleRunStatus>().notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workflowForIdx: uniqueIndex("goat_workflow_schedule_runs_workflow_for_idx").on(
      table.workflowId,
      table.scheduledFor,
    ),
    workspaceCreatedIdx: index("goat_workflow_schedule_runs_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    userCreatedIdx: index("goat_workflow_schedule_runs_user_created_idx").on(
      table.userWorkosId,
      table.createdAt,
    ),
    taskIdx: index("goat_workflow_schedule_runs_task_idx").on(table.taskId),
    statusCheck: check(
      "goat_workflow_schedule_runs_status_check",
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
    messageId: text("message_id").references(() => goatTaskMessages.id, {
      onDelete: "set null",
    }),
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
    providerCostUsdMicros: bigint("provider_cost_usd_micros", {
      mode: "number",
    })
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
    providerCostUsdMicros: bigint("provider_cost_usd_micros", {
      mode: "number",
    })
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
    providerCostUsdMicros: bigint("provider_cost_usd_micros", {
      mode: "number",
    })
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
    engine: text("engine").$type<GoatChatEngine>().notNull().default("opencompany"),
    kind: text("kind").$type<GoatChatSessionKind>().notNull().default("chat"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userOpenUpdatedIdx: index("goat_chat_sessions_user_open_updated_idx").on(
      table.userWorkosId,
      table.closedAt,
      table.updatedAt,
    ),
    engineCheck: check(
      "goat_chat_sessions_engine_check",
      sql`${table.engine} IN ('opencompany', 'codex', 'claude_code')`,
    ),
    kindCheck: check("goat_chat_sessions_kind_check", sql`${table.kind} IN ('chat', 'task')`),
  }),
);

// An explicit, unguessable public read boundary for a chat session. Shares are
// separate from sessions so future access controls (revocation, expiry, password
// hashes, or snapshot boundaries) can evolve without widening the core chat row.
export const goatChatShares = goat.table(
  "chat_session_shares",
  {
    id: text("id").primaryKey(),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => goatChatSessions.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    chatSessionIdx: uniqueIndex("goat_chat_session_shares_chat_session_idx").on(
      table.chatSessionId,
    ),
  }),
);

// Harness-neutral, durable governance for one cloud action turn. It is the
// atomic enforcement boundary shared by Codex and MCP requests; foreground
// chat uses the same action service with request-local governance.
export const goatActionTurns = goat.table(
  "action_turns",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => goatWorkspaces.id, { onDelete: "cascade" }),
    policy: text("policy")
      .$type<"foregroundInteractive" | "cloudReadOnly" | "headless">()
      .notNull(),
    actionCallCount: integer("action_call_count").notNull().default(0),
    invocationIds: jsonb("invocation_ids").$type<string[]>().notNull().default([]),
    listedSourceIds: jsonb("listed_source_ids").$type<string[]>().notNull().default([]),
    quotedTotalUsdMicros: bigint("quoted_total_usd_micros", { mode: "number" })
      .notNull()
      .default(0),
    admittedInvocationIds: jsonb("admitted_invocation_ids").$type<string[]>().notNull().default([]),
    capabilityQuotes: jsonb("capability_quotes")
      .$type<Record<string, Record<string, unknown>>>()
      .notNull()
      .default({}),
    asyncRunsStarted: integer("async_runs_started").notNull().default(0),
    asyncInvocationIds: jsonb("async_invocation_ids").$type<string[]>().notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionTurnIdx: uniqueIndex("goat_action_turns_session_turn_idx").on(
      table.sessionId,
      table.turnId,
    ),
    expiresIdx: index("goat_action_turns_expires_idx").on(table.expiresAt),
    policyCheck: check(
      "goat_action_turns_policy_check",
      sql`${table.policy} IN ('foregroundInteractive', 'cloudReadOnly', 'headless')`,
    ),
    countersCheck: check(
      "goat_action_turns_counters_check",
      sql`${table.actionCallCount} >= 0
        AND ${table.quotedTotalUsdMicros} >= 0
        AND ${table.asyncRunsStarted} >= 0`,
    ),
  }),
);

// Durable paid-capability lifecycle. Inputs and provider output intentionally
// stay out of this table: the exact input is bound by input_hash and the
// safety-bounded provider result lives only in the requesting chat trace.
export const goatCapabilityRuns = goat.table(
  "capability_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => goatWorkspaces.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => goatChatSessions.id, { onDelete: "restrict" }),
    toolCallId: text("tool_call_id"),
    source: text("source").$type<GoatManagedCapabilitySource>().notNull(),
    action: text("action").notNull(),
    inputHash: text("input_hash").notNull(),
    provider: text("provider").notNull(),
    endpoint: text("endpoint").notNull(),
    status: text("status").$type<GoatCapabilityRunStatus>().notNull(),
    quoteProviderCostUsdMicros: bigint("quote_provider_cost_usd_micros", {
      mode: "number",
    }).notNull(),
    quotePlatformFeeUsdMicros: bigint("quote_platform_fee_usd_micros", {
      mode: "number",
    }).notNull(),
    quoteTotalCostUsdMicros: bigint("quote_total_cost_usd_micros", {
      mode: "number",
    }).notNull(),
    monidRunId: text("monid_run_id"),
    providerHttpStatus: integer("provider_http_status"),
    resultCount: integer("result_count"),
    providerCostUsdMicros: bigint("provider_cost_usd_micros", { mode: "number" }),
    platformFeeUsdMicros: bigint("platform_fee_usd_micros", { mode: "number" }),
    totalCostUsdMicros: bigint("total_cost_usd_micros", { mode: "number" }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    approvalExpiresAt: timestamp("approval_expires_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    monidRunIdx: uniqueIndex("goat_capability_runs_monid_run_idx")
      .on(table.monidRunId)
      .where(sql`${table.monidRunId} IS NOT NULL`),
    workspaceCreatedIdx: index("goat_capability_runs_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    chatSessionIdx: index("goat_capability_runs_chat_session_idx").on(table.chatSessionId),
    reconciliationIdx: index("goat_capability_runs_reconciliation_idx")
      .on(table.updatedAt, table.id)
      .where(
        sql`${table.status} IN ('executing', 'running', 'stopping') AND ${table.settledAt} IS NULL`,
      ),
    approvalIdx: index("goat_capability_runs_approval_idx").on(
      table.userWorkosId,
      table.chatSessionId,
      table.status,
      table.approvalExpiresAt,
    ),
    sourceCheck: check(
      "goat_capability_runs_source_check",
      sql`${table.source} IN ('x', 'linkedin', 'youtube', 'instagram', 'tiktok', 'lead', 'seo')`,
    ),
    providerCheck: check(
      "goat_capability_runs_provider_check",
      sql`${table.provider} IN ('tikhub', 'apify', 'pdl', 'semrush')`,
    ),
    inputHashCheck: check(
      "goat_capability_runs_input_hash_check",
      sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`,
    ),
    moneyCheck: check(
      "goat_capability_runs_money_check",
      sql`${table.quoteProviderCostUsdMicros} >= 0
        AND ${table.quotePlatformFeeUsdMicros} >= 0
        AND ${table.quoteTotalCostUsdMicros} >= 0
        AND ${table.quoteTotalCostUsdMicros} = ${table.quoteProviderCostUsdMicros} + ${table.quotePlatformFeeUsdMicros}
        AND (${table.providerCostUsdMicros} IS NULL OR ${table.providerCostUsdMicros} >= 0)
        AND (${table.platformFeeUsdMicros} IS NULL OR ${table.platformFeeUsdMicros} >= 0)
        AND (${table.totalCostUsdMicros} IS NULL OR ${table.totalCostUsdMicros} >= 0)
        AND (
          (${table.providerCostUsdMicros} IS NULL AND ${table.platformFeeUsdMicros} IS NULL AND ${table.totalCostUsdMicros} IS NULL)
          OR (
            ${table.providerCostUsdMicros} IS NOT NULL
            AND ${table.platformFeeUsdMicros} IS NOT NULL
            AND ${table.totalCostUsdMicros} = ${table.providerCostUsdMicros} + ${table.platformFeeUsdMicros}
          )
        )
        AND (${table.resultCount} IS NULL OR ${table.resultCount} >= 0)`,
    ),
    statusCheck: check(
      "goat_capability_runs_status_check",
      sql`${table.status} IN ('awaiting_approval', 'approved', 'canceled', 'expired', 'executing', 'running', 'stopping', 'succeeded', 'failed', 'stopped', 'timed_out')`,
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
    taskId: text("task_id").references(() => goatTasks.id, {
      onDelete: "set null",
    }),
    debugTrace: jsonb("debug_trace").$type<GoatChatMessageDebugTrace | null>(),
    attachments: jsonb("attachments").$type<GoatChatMessageAttachment[] | null>(),
    // docx/xlsx/srt extracted text keyed by attachment id; server-side model context
    // only — excluded from the Electric shape.
    attachmentTexts: jsonb("attachment_texts").$type<Record<string, string> | null>(),
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

// One immutable row per Auto classifier attempt. Prompt content is deliberately
// excluded; lengths, outcomes, safe provider metadata, and usage are sufficient
// to diagnose routing reliability without creating a second message store.
export const goatChatModelRoutingAttempts = goat.table(
  "chat_model_routing_attempts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => goatWorkspaces.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    chatSessionId: text("chat_session_id").references(() => goatChatSessions.id, {
      onDelete: "set null",
    }),
    userMessageId: text("user_message_id").references(() => goatChatMessages.id, {
      onDelete: "set null",
    }),
    classifierModel: text("classifier_model").notNull(),
    selectedModel: text("selected_model").$type<AgentModelId>().notNull(),
    tier: text("tier").$type<GoatChatModelRoutingTier>().notNull(),
    reason: text("reason").$type<GoatChatModelRoutingReason>().notNull(),
    outcome: text("outcome").$type<GoatChatModelRoutingOutcome>().notNull(),
    durationMs: integer("duration_ms").notNull(),
    errorCategory: text("error_category").$type<GoatChatModelRoutingErrorCategory>(),
    finishReason: text("finish_reason"),
    providerStatusCode: integer("provider_status_code"),
    providerRetryable: boolean("provider_retryable"),
    promptLength: integer("prompt_length").notNull(),
    attachmentCount: integer("attachment_count").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceCreatedIdx: index("goat_chat_model_routing_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    sessionCreatedIdx: index("goat_chat_model_routing_session_created_idx").on(
      table.chatSessionId,
      table.createdAt,
    ),
    outcomeCreatedIdx: index("goat_chat_model_routing_outcome_created_idx").on(
      table.outcome,
      table.createdAt,
    ),
    userMessageIdx: index("goat_chat_model_routing_user_message_idx").on(table.userMessageId),
    tierCheck: check(
      "goat_chat_model_routing_tier_check",
      sql`${table.tier} IN ('standard', 'frontier')`,
    ),
    reasonCheck: check(
      "goat_chat_model_routing_reason_check",
      sql`${table.reason} IN ('pdf_attachment', 'attachment', 'simple_answer', 'summarization', 'drafting', 'single_action', 'multi_step', 'analysis', 'coding', 'high_stakes', 'ambiguous', 'router_fallback')`,
    ),
    outcomeCheck: check(
      "goat_chat_model_routing_outcome_check",
      sql`${table.outcome} IN ('success', 'skipped', 'timeout', 'error', 'invalid')`,
    ),
    errorCategoryCheck: check(
      "goat_chat_model_routing_error_category_check",
      sql`${table.errorCategory} IS NULL OR ${table.errorCategory} IN ('output_length', 'invalid_output', 'timeout', 'rate_limit', 'provider', 'unknown')`,
    ),
    nonNegativeMetricsCheck: check(
      "goat_chat_model_routing_non_negative_metrics_check",
      sql`${table.durationMs} >= 0 AND ${table.promptLength} >= 0 AND ${table.attachmentCount} >= 0 AND ${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0 AND ${table.totalTokens} >= 0`,
    ),
    providerStatusCodeCheck: check(
      "goat_chat_model_routing_provider_status_code_check",
      sql`${table.providerStatusCode} IS NULL OR ${table.providerStatusCode} BETWEEN 100 AND 599`,
    ),
  }),
);

export const goatChatSandboxUsage = goat.table(
  "chat_sandbox_usage",
  {
    id: serial("id").primaryKey(),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => goatChatSessions.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    userMessageId: text("user_message_id").references(() => goatChatMessages.id, {
      onDelete: "set null",
    }),
    sandboxId: text("sandbox_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    activeMs: integer("active_ms").notNull().default(0),
    providerCostUsdMicros: bigint("provider_cost_usd_micros", {
      mode: "number",
    })
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
    userSessionCreatedAtIdx: index("goat_chat_sandbox_usage_user_session_created_at_idx").on(
      table.userWorkosId,
      table.chatSessionId,
      table.createdAt,
    ),
    sessionCreatedAtIdx: index("goat_chat_sandbox_usage_session_created_at_idx").on(
      table.chatSessionId,
      table.createdAt,
    ),
    userMessageIdx: index("goat_chat_sandbox_usage_user_message_idx").on(table.userMessageId),
    sandboxIdx: index("goat_chat_sandbox_usage_sandbox_idx").on(table.sandboxId),
  }),
);

export const goatBrowserProfiles = goat.table(
  "browser_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    name: text("name").notNull(),
    siteHost: text("site_host").notNull(),
    allowedHosts: jsonb("allowed_hosts").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: text("status").$type<GoatBrowserProfileStatus>().notNull().default("pending_login"),
    encryptedBrowserbaseContextId: jsonb("encrypted_browserbase_context_id")
      .$type<GoatIntegrationCredentialEncryptedPayload>()
      .notNull(),
    encryptionKeyVersion: integer("encryption_key_version").notNull(),
    activeSessionId: text("active_session_id"),
    lastLoginSessionId: text("last_login_session_id"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userStatusIdx: index("goat_browser_profiles_user_status_idx").on(
      table.userWorkosId,
      table.status,
    ),
    userHostNameIdx: uniqueIndex("goat_browser_profiles_user_host_name_idx").on(
      table.userWorkosId,
      table.siteHost,
      table.name,
    ),
    activeSessionIdx: index("goat_browser_profiles_active_session_idx").on(table.activeSessionId),
    statusCheck: check(
      "goat_browser_profiles_status_check",
      sql`${table.status} IN ('pending_login', 'connected', 'needs_reauth', 'disconnected')`,
    ),
  }),
);

export const goatBrowserProfileSessions = goat.table(
  "browser_profile_sessions",
  {
    id: serial("id").primaryKey(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => goatBrowserProfiles.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    chatSessionId: text("chat_session_id").references(() => goatChatSessions.id, {
      onDelete: "set null",
    }),
    userMessageId: text("user_message_id").references(() => goatChatMessages.id, {
      onDelete: "set null",
    }),
    browserbaseSessionId: text("browserbase_session_id").notNull(),
    kind: text("kind").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMs: integer("duration_ms").notNull().default(0),
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
    profileCreatedIdx: index("goat_browser_profile_sessions_profile_created_idx").on(
      table.profileId,
      table.createdAt,
    ),
    userChatCreatedIdx: index("goat_browser_profile_sessions_user_chat_created_idx").on(
      table.userWorkosId,
      table.chatSessionId,
      table.createdAt,
    ),
    browserbaseSessionIdx: index("goat_browser_profile_sessions_browserbase_session_idx").on(
      table.browserbaseSessionId,
    ),
    kindCheck: check(
      "goat_browser_profile_sessions_kind_check",
      sql`${table.kind} IN ('login', 'agent')`,
    ),
  }),
);

// Immutable skill snapshots activated by an explicit @skill mention in a chat. Keeping the
// activation message lets non-Codex chat replay the skill as part of conversation history, while
// Codex can materialize every active snapshot and invoke only the skills selected on the turn.
export const goatChatSessionSkills = goat.table(
  "chat_session_skills",
  {
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => goatChatSessions.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    // Provenance only: the immutable snapshot must survive deletion of its source Brain.
    brainRef: text("brain_ref").notNull(),
    activatedMessageId: text("activated_message_id")
      .notNull()
      .references(() => goatChatMessages.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    instructions: text("instructions").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chatSessionId, table.skillId] }),
    activatedMessageIdx: index("goat_chat_session_skills_activated_message_idx").on(
      table.activatedMessageId,
    ),
    brainIdx: index("goat_chat_session_skills_brain_idx").on(table.brainRef),
  }),
);

export const goatCodexChatSessions = goat.table(
  "codex_chat_sessions",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => goatChatSessions.id, { onDelete: "cascade" }),
    engine: text("engine").$type<GoatCodexChatEngine>().notNull().default("codex"),
    model: text("model").notNull().default("gpt-5.5"),
    brainRef: text("brain_ref").references(() => goatBrains.id, {
      onDelete: "set null",
    }),
    workspaceId: text("workspace_id").references(() => goatWorkspaces.id, {
      onDelete: "set null",
    }),
    hostToolContractVersion: text("host_tool_contract_version"),
    sandboxId: text("sandbox_id"),
    codexThreadId: text("codex_thread_id"),
    activeTurnId: text("active_turn_id"),
    status: text("status").$type<GoatCodexChatSessionStatus>().notNull().default("queued"),
    error: text("error"),
    sandboxTimeoutArmedAt: timestamp("sandbox_timeout_armed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    chatSessionIdx: uniqueIndex("goat_codex_chat_sessions_chat_session_idx").on(
      table.chatSessionId,
    ),
    userUpdatedIdx: index("goat_codex_chat_sessions_user_updated_idx").on(
      table.userWorkosId,
      table.updatedAt,
    ),
    terminalSandboxSweepIdx: index("goat_codex_chat_sessions_terminal_sandbox_sweep_idx")
      .on(table.updatedAt, table.id)
      .where(sql`
        ${table.sandboxId} IS NOT NULL
        AND ${table.status} IN ('idle', 'failed', 'interrupted', 'closed')
        AND (
          ${table.sandboxTimeoutArmedAt} IS NULL
          OR ${table.sandboxTimeoutArmedAt} < ${table.updatedAt}
        )
      `),
    statusCheck: check(
      "goat_codex_chat_sessions_status_check",
      sql`${table.status} IN ('queued', 'starting', 'idle', 'running', 'failed', 'interrupted', 'closed')`,
    ),
    engineCheck: check(
      "goat_codex_chat_sessions_engine_check",
      sql`${table.engine} IN ('opencompany', 'codex', 'claude_code')`,
    ),
  }),
);

export const goatCodexChatTurns = goat.table(
  "codex_chat_turns",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    codexChatSessionId: text("codex_chat_session_id")
      .notNull()
      .references(() => goatCodexChatSessions.id, { onDelete: "cascade" }),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => goatChatSessions.id, { onDelete: "cascade" }),
    userMessageId: text("user_message_id")
      .notNull()
      .references(() => goatChatMessages.id, { onDelete: "cascade" }),
    assistantMessageId: text("assistant_message_id")
      .notNull()
      .references(() => goatChatMessages.id, { onDelete: "cascade" }),
    codexTurnId: text("codex_turn_id"),
    status: text("status").$type<GoatCodexChatTurnStatus>().notNull().default("queued"),
    prompt: text("prompt").notNull(),
    settings: jsonb("settings")
      .$type<GoatCodexChatTurnSettings>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    error: text("error"),
    interruptRequestedAt: timestamp("interrupt_requested_at", {
      withTimezone: true,
    }),
    attempts: integer("attempts").notNull().default(0),
    recoveryAttempts: integer("recovery_attempts").notNull().default(0),
    engineRecoveryRequired: boolean("engine_recovery_required").notNull().default(false),
    engineTurnBaselineIds: jsonb("engine_turn_baseline_ids").$type<string[]>(),
    leaseId: text("lease_id"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    runAfter: timestamp("run_after", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    claimIdx: index("goat_codex_chat_turns_claim_idx").on(table.status, table.createdAt),
    sessionCreatedIdx: index("goat_codex_chat_turns_session_created_idx").on(
      table.codexChatSessionId,
      table.createdAt,
    ),
    assistantMessageIdx: uniqueIndex("goat_codex_chat_turns_assistant_message_idx").on(
      table.assistantMessageId,
    ),
    statusCheck: check(
      "goat_codex_chat_turns_status_check",
      sql`${table.status} IN ('queued', 'running', 'completed', 'failed', 'interrupted')`,
    ),
  }),
);

export const goatCodexChatInteractions = goat.table(
  "codex_chat_interactions",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    codexChatSessionId: text("codex_chat_session_id")
      .notNull()
      .references(() => goatCodexChatSessions.id, { onDelete: "cascade" }),
    codexChatTurnId: text("codex_chat_turn_id")
      .notNull()
      .references(() => goatCodexChatTurns.id, { onDelete: "cascade" }),
    leaseId: text("lease_id").notNull(),
    requestId: text("request_id").notNull(),
    itemId: text("item_id"),
    method: text("method").notNull(),
    status: text("status").$type<GoatCodexChatInteractionStatus>().notNull().default("pending"),
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    response: jsonb("response").$type<Record<string, unknown>>(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionStatusIdx: index("goat_codex_chat_interactions_session_status_idx").on(
      table.codexChatSessionId,
      table.status,
      table.createdAt,
    ),
    turnCreatedIdx: index("goat_codex_chat_interactions_turn_created_idx").on(
      table.codexChatTurnId,
      table.createdAt,
    ),
    statusCheck: check(
      "goat_codex_chat_interactions_status_check",
      sql`${table.status} IN ('pending', 'resolved', 'canceled')`,
    ),
    methodCheck: check(
      "goat_codex_chat_interactions_method_check",
      sql`${table.method} = 'item/tool/requestUserInput'`,
    ),
  }),
);

export const goatCodexChatEvents = goat.table(
  "codex_chat_events",
  {
    id: serial("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    codexChatSessionId: text("codex_chat_session_id")
      .notNull()
      .references(() => goatCodexChatSessions.id, { onDelete: "cascade" }),
    codexChatTurnId: text("codex_chat_turn_id").references(() => goatCodexChatTurns.id, {
      onDelete: "set null",
    }),
    eventKey: text("event_key"),
    type: text("type").$type<GoatCodexChatEventType>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    rawEvent: jsonb("raw_event").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionCreatedIdx: index("goat_codex_chat_events_session_created_idx").on(
      table.codexChatSessionId,
      table.createdAt,
    ),
    turnCreatedIdx: index("goat_codex_chat_events_turn_created_idx").on(
      table.codexChatTurnId,
      table.createdAt,
    ),
    turnEventKeyIdx: uniqueIndex("goat_codex_chat_events_turn_event_key_idx")
      .on(table.codexChatTurnId, table.eventKey)
      .where(sql`${table.eventKey} IS NOT NULL`),
    typeCheck: check(
      "goat_codex_chat_events_type_check",
      sql`${table.type} IN (${sql.join(
        GOAT_CODEX_CHAT_EVENT_TYPES.map((eventType) => sql`${eventType}`),
        sql`, `,
      )})`,
    ),
  }),
);

export const goatBrainToolRuns = goat.table(
  "brain_tool_runs",
  {
    id: text("id").primaryKey(),
    brainRef: text("brain_ref").references(() => goatBrains.id, {
      onDelete: "set null",
    }),
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
    brainCreatedAtIdx: index("goat_brain_tool_runs_brain_created_at_idx").on(
      table.brainRef,
      table.createdAt,
    ),
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

// Claude Code subscription auth: one long-lived setup-token per user, pasted in
// settings (no device flow exists for Claude Code). Strictly per-user — sharing a
// subscription credential across users is prohibited by Anthropic's terms.
export const goatClaudeCodeCredentials = goat.table(
  "claude_code_credentials",
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
    statusIdx: index("goat_claude_code_credentials_status_idx").on(table.status),
    statusCheck: check(
      "goat_claude_code_credentials_status_check",
      sql`${table.status} IN ('connected', 'needs_reauth')`,
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
  chatSandboxUsage: many(goatChatSandboxUsage),
  browserProfiles: many(goatBrowserProfiles),
  browserProfileSessions: many(goatBrowserProfileSessions),
  capabilityRuns: many(goatCapabilityRuns),
  capabilityOverrides: many(goatWorkspaceCapabilities),
  integrations: many(goatIntegrations),
  integrationCredentials: many(goatIntegrationCredentials),
  integrationResources: many(goatIntegrationResources),
  repoConfigs: many(goatRepoConfigs),
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
  capabilities: many(goatWorkspaceCapabilities),
  capabilityRuns: many(goatCapabilityRuns),
  billing: one(goatWorkspaceBilling),
  ingestionReservations: many(goatWorkspaceIngestionReservations),
  brains: many(goatBrains),
  repoConfigs: many(goatRepoConfigs),
}));

export const goatWorkspaceBillingRelations = relations(goatWorkspaceBilling, ({ one }) => ({
  workspace: one(goatWorkspaces, {
    fields: [goatWorkspaceBilling.workspaceId],
    references: [goatWorkspaces.id],
  }),
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

export const goatWorkspaceCapabilitiesRelations = relations(
  goatWorkspaceCapabilities,
  ({ one }) => ({
    workspace: one(goatWorkspaces, {
      fields: [goatWorkspaceCapabilities.workspaceId],
      references: [goatWorkspaces.id],
    }),
    updatedBy: one(goatUsers, {
      fields: [goatWorkspaceCapabilities.updatedByWorkosId],
      references: [goatUsers.workosUserId],
    }),
  }),
);

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

export const goatCodexChatSessionsRelations = relations(goatCodexChatSessions, ({ one, many }) => ({
  user: one(goatUsers, {
    fields: [goatCodexChatSessions.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  chatSession: one(goatChatSessions, {
    fields: [goatCodexChatSessions.chatSessionId],
    references: [goatChatSessions.id],
  }),
  turns: many(goatCodexChatTurns),
  interactions: many(goatCodexChatInteractions),
  events: many(goatCodexChatEvents),
}));

export const goatCodexChatTurnsRelations = relations(goatCodexChatTurns, ({ one, many }) => ({
  user: one(goatUsers, {
    fields: [goatCodexChatTurns.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  codexChatSession: one(goatCodexChatSessions, {
    fields: [goatCodexChatTurns.codexChatSessionId],
    references: [goatCodexChatSessions.id],
  }),
  chatSession: one(goatChatSessions, {
    fields: [goatCodexChatTurns.chatSessionId],
    references: [goatChatSessions.id],
  }),
  userMessage: one(goatChatMessages, {
    fields: [goatCodexChatTurns.userMessageId],
    references: [goatChatMessages.id],
    relationName: "goat_codex_chat_turns_user_message",
  }),
  assistantMessage: one(goatChatMessages, {
    fields: [goatCodexChatTurns.assistantMessageId],
    references: [goatChatMessages.id],
    relationName: "goat_codex_chat_turns_assistant_message",
  }),
  interactions: many(goatCodexChatInteractions),
  events: many(goatCodexChatEvents),
}));

export const goatCodexChatInteractionsRelations = relations(
  goatCodexChatInteractions,
  ({ one }) => ({
    user: one(goatUsers, {
      fields: [goatCodexChatInteractions.userWorkosId],
      references: [goatUsers.workosUserId],
    }),
    codexChatSession: one(goatCodexChatSessions, {
      fields: [goatCodexChatInteractions.codexChatSessionId],
      references: [goatCodexChatSessions.id],
    }),
    codexChatTurn: one(goatCodexChatTurns, {
      fields: [goatCodexChatInteractions.codexChatTurnId],
      references: [goatCodexChatTurns.id],
    }),
  }),
);

export const goatCodexChatEventsRelations = relations(goatCodexChatEvents, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatCodexChatEvents.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  codexChatSession: one(goatCodexChatSessions, {
    fields: [goatCodexChatEvents.codexChatSessionId],
    references: [goatCodexChatSessions.id],
  }),
  codexChatTurn: one(goatCodexChatTurns, {
    fields: [goatCodexChatEvents.codexChatTurnId],
    references: [goatCodexChatTurns.id],
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

export const goatClaudeCodeCredentialsRelations = relations(
  goatClaudeCodeCredentials,
  ({ one }) => ({
    user: one(goatUsers, {
      fields: [goatClaudeCodeCredentials.userWorkosId],
      references: [goatUsers.workosUserId],
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

export const goatRepoConfigsRelations = relations(goatRepoConfigs, ({ one }) => ({
  workspace: one(goatWorkspaces, {
    fields: [goatRepoConfigs.workspaceId],
    references: [goatWorkspaces.id],
  }),
  createdBy: one(goatUsers, {
    fields: [goatRepoConfigs.createdByWorkosId],
    references: [goatUsers.workosUserId],
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
  workspaceReservations: many(goatWorkspaceIngestionReservations),
}));

export const goatWorkspaceIngestionReservationsRelations = relations(
  goatWorkspaceIngestionReservations,
  ({ one }) => ({
    workspace: one(goatWorkspaces, {
      fields: [goatWorkspaceIngestionReservations.workspaceId],
      references: [goatWorkspaces.id],
    }),
    sourceItem: one(goatBrainSourceItems, {
      fields: [goatWorkspaceIngestionReservations.sourceItemId],
      references: [goatBrainSourceItems.id],
    }),
  }),
);

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
  workspace: one(goatWorkspaces, {
    fields: [goatTasks.workspaceId],
    references: [goatWorkspaces.id],
  }),
  session: one(goatChatSessions, {
    fields: [goatTasks.sessionId],
    references: [goatChatSessions.id],
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
  workflowScheduleRuns: many(goatWorkflowScheduleRuns),
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

export const goatWorkflowScheduleRunsRelations = relations(goatWorkflowScheduleRuns, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatWorkflowScheduleRuns.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  workspace: one(goatWorkspaces, {
    fields: [goatWorkflowScheduleRuns.workspaceId],
    references: [goatWorkspaces.id],
  }),
  workflow: one(goatWorkflows, {
    fields: [goatWorkflowScheduleRuns.workflowId],
    references: [goatWorkflows.id],
  }),
  task: one(goatTasks, {
    fields: [goatWorkflowScheduleRuns.taskId],
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
  task: one(goatTasks),
  messages: many(goatChatMessages),
  modelRoutingAttempts: many(goatChatModelRoutingAttempts),
  sandboxUsage: many(goatChatSandboxUsage),
  browserProfileSessions: many(goatBrowserProfileSessions),
  skills: many(goatChatSessionSkills),
  brainToolRuns: many(goatBrainToolRuns),
  capabilityRuns: many(goatCapabilityRuns),
}));

export const goatChatSharesRelations = relations(goatChatShares, ({ one }) => ({
  chatSession: one(goatChatSessions, {
    fields: [goatChatShares.chatSessionId],
    references: [goatChatSessions.id],
  }),
}));

export const goatCapabilityRunsRelations = relations(goatCapabilityRuns, ({ one }) => ({
  workspace: one(goatWorkspaces, {
    fields: [goatCapabilityRuns.workspaceId],
    references: [goatWorkspaces.id],
  }),
  user: one(goatUsers, {
    fields: [goatCapabilityRuns.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  chatSession: one(goatChatSessions, {
    fields: [goatCapabilityRuns.chatSessionId],
    references: [goatChatSessions.id],
  }),
}));

export const goatChatMessagesRelations = relations(goatChatMessages, ({ one, many }) => ({
  session: one(goatChatSessions, {
    fields: [goatChatMessages.sessionId],
    references: [goatChatSessions.id],
  }),
  task: one(goatTasks, {
    fields: [goatChatMessages.taskId],
    references: [goatTasks.id],
  }),
  activatedSkills: many(goatChatSessionSkills),
  sandboxUsage: many(goatChatSandboxUsage),
  modelRoutingAttempts: many(goatChatModelRoutingAttempts),
}));

export const goatChatModelRoutingAttemptsRelations = relations(
  goatChatModelRoutingAttempts,
  ({ one }) => ({
    workspace: one(goatWorkspaces, {
      fields: [goatChatModelRoutingAttempts.workspaceId],
      references: [goatWorkspaces.id],
    }),
    user: one(goatUsers, {
      fields: [goatChatModelRoutingAttempts.userWorkosId],
      references: [goatUsers.workosUserId],
    }),
    session: one(goatChatSessions, {
      fields: [goatChatModelRoutingAttempts.chatSessionId],
      references: [goatChatSessions.id],
    }),
    userMessage: one(goatChatMessages, {
      fields: [goatChatModelRoutingAttempts.userMessageId],
      references: [goatChatMessages.id],
    }),
  }),
);

export const goatChatSandboxUsageRelations = relations(goatChatSandboxUsage, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatChatSandboxUsage.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  session: one(goatChatSessions, {
    fields: [goatChatSandboxUsage.chatSessionId],
    references: [goatChatSessions.id],
  }),
  userMessage: one(goatChatMessages, {
    fields: [goatChatSandboxUsage.userMessageId],
    references: [goatChatMessages.id],
  }),
}));

export const goatBrowserProfilesRelations = relations(goatBrowserProfiles, ({ one, many }) => ({
  user: one(goatUsers, {
    fields: [goatBrowserProfiles.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  sessions: many(goatBrowserProfileSessions),
}));

export const goatBrowserProfileSessionsRelations = relations(
  goatBrowserProfileSessions,
  ({ one }) => ({
    profile: one(goatBrowserProfiles, {
      fields: [goatBrowserProfileSessions.profileId],
      references: [goatBrowserProfiles.id],
    }),
    user: one(goatUsers, {
      fields: [goatBrowserProfileSessions.userWorkosId],
      references: [goatUsers.workosUserId],
    }),
    chatSession: one(goatChatSessions, {
      fields: [goatBrowserProfileSessions.chatSessionId],
      references: [goatChatSessions.id],
    }),
    userMessage: one(goatChatMessages, {
      fields: [goatBrowserProfileSessions.userMessageId],
      references: [goatChatMessages.id],
    }),
  }),
);

export const goatChatSessionSkillsRelations = relations(goatChatSessionSkills, ({ one }) => ({
  session: one(goatChatSessions, {
    fields: [goatChatSessionSkills.chatSessionId],
    references: [goatChatSessions.id],
  }),
  brain: one(goatBrains, {
    fields: [goatChatSessionSkills.brainRef],
    references: [goatBrains.id],
  }),
  activatedMessage: one(goatChatMessages, {
    fields: [goatChatSessionSkills.activatedMessageId],
    references: [goatChatMessages.id],
  }),
}));

export type GoatUser = typeof goatUsers.$inferSelect;
export type GoatWorkspace = typeof goatWorkspaces.$inferSelect;
export type GoatOnboarding = typeof goatOnboarding.$inferSelect;
export type GoatOnboardingEmail = typeof goatOnboardingEmails.$inferSelect;
export type GoatWorkspaceMember = typeof goatWorkspaceMembers.$inferSelect;
export type GoatWorkspaceCapability = typeof goatWorkspaceCapabilities.$inferSelect;
export type GoatWorkspaceBilling = typeof goatWorkspaceBilling.$inferSelect;
export type GoatWorkspaceIngestionReservation =
  typeof goatWorkspaceIngestionReservations.$inferSelect;
export type GoatBrain = typeof goatBrains.$inferSelect;
export type GoatBrainMember = typeof goatBrainMembers.$inferSelect;
export type GoatBrainFolder = typeof goatBrainFolders.$inferSelect;
export type GoatBrainDocument = typeof goatBrainDocuments.$inferSelect;
export type GoatBrainTimelineEntryRecord = typeof goatBrainTimelineEntries.$inferSelect;
export type GoatBrainEdge = typeof goatBrainEdges.$inferSelect;
export type GoatBrainDocumentEmbedding = typeof goatBrainDocumentEmbeddings.$inferSelect;
export type GoatBrainDocumentVersion = typeof goatBrainDocumentVersions.$inferSelect;
export type GoatBrainToolRun = typeof goatBrainToolRuns.$inferSelect;
export type GoatCodexChatSession = typeof goatCodexChatSessions.$inferSelect;
export type GoatCodexChatTurn = typeof goatCodexChatTurns.$inferSelect;
export type GoatCodexChatInteraction = typeof goatCodexChatInteractions.$inferSelect;
export type GoatCodexChatEvent = typeof goatCodexChatEvents.$inferSelect;
export type GoatIntegration = typeof goatIntegrations.$inferSelect;
export type GoatIntegrationCredential = typeof goatIntegrationCredentials.$inferSelect;
export type GoatBrainSourceItem = typeof goatBrainSourceItems.$inferSelect;
export type GoatBrainIngestJob = typeof goatBrainIngestJobs.$inferSelect;
export type GoatCodexCredential = typeof goatCodexCredentials.$inferSelect;
export type GoatClaudeCodeCredential = typeof goatClaudeCodeCredentials.$inferSelect;
export type GoatCodexDeviceAuthFlow = typeof goatCodexDeviceAuthFlows.$inferSelect;
export type GoatTaskSchedule = typeof goatTaskSchedules.$inferSelect;
export type GoatTaskScheduleRun = typeof goatTaskScheduleRuns.$inferSelect;
export type GoatWorkflowScheduleRun = typeof goatWorkflowScheduleRuns.$inferSelect;
export type GoatTask = typeof goatTasks.$inferSelect;
export type GoatTaskMessage = typeof goatTaskMessages.$inferSelect;
export type GoatTaskEvent = typeof goatTaskEvents.$inferSelect;
export type GoatTaskModelUsage = typeof goatTaskModelUsage.$inferSelect;
export type GoatTaskToolUsage = typeof goatTaskToolUsage.$inferSelect;
export type GoatTaskSandboxUsage = typeof goatTaskSandboxUsage.$inferSelect;
export type GoatChatSession = typeof goatChatSessions.$inferSelect;
export type GoatChatShare = typeof goatChatShares.$inferSelect;
export type GoatActionTurn = typeof goatActionTurns.$inferSelect;
export type GoatCapabilityRun = typeof goatCapabilityRuns.$inferSelect;
export type GoatChatMessage = typeof goatChatMessages.$inferSelect;
export type GoatChatModelRoutingAttempt = typeof goatChatModelRoutingAttempts.$inferSelect;
export type GoatChatSandboxUsage = typeof goatChatSandboxUsage.$inferSelect;
export type GoatBrowserProfile = typeof goatBrowserProfiles.$inferSelect;
export type GoatBrowserProfileSession = typeof goatBrowserProfileSessions.$inferSelect;
export type GoatChatSessionSkill = typeof goatChatSessionSkills.$inferSelect;
export type GoatWorkflow = typeof goatWorkflows.$inferSelect;
export type GoatSkill = typeof goatSkills.$inferSelect;
export type GoatRepoConfig = typeof goatRepoConfigs.$inferSelect;
