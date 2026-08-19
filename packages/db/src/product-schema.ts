import type { AgentModelId, CodexReasoningEffort } from "@opencompany/agent-runtime/types";
import {
  APPROVAL_RESOLUTIONS,
  type ApprovalResolution,
  CHAT_ATTACHMENT_FORMATS,
  type ChatAttachmentFormat,
  type ConversationRuntimeStatus,
  RUN_APPROVAL_STATUSES,
  RUN_ATTEMPT_STATUSES,
  RUN_EVENT_TYPES,
  type RunApprovalStatus,
  type RunAttemptStatus,
  type RunEventType,
  type RunStatus,
  TASK_SOURCES,
  type TaskSource,
} from "@opencompany/core";
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

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

// Workflows and skills share a simple draft/active lifecycle: `draft` is
// editable-but-not-yet-usable, `active` is available to fire (workflows) or
// attach (skills). Mirrors the frontmatter `status` the Brain docs carried.
export type WorkflowStatus = "draft" | "active";
export type WorkflowTrigger = "manual" | "slack" | "linear" | "schedule";
export type AutomationCommandOperation = "workflow.create" | "task_schedule.create";
export type KnowledgeCommandOperation =
  | "brain_document.create"
  | "brain_asset.create"
  | "brain_asset.replace"
  | "wiki_page.create"
  | "wiki_timeline.create"
  | "skill.create"
  | "skill.import"
  | "brain_import.start";
export type BillingCommandOperation =
  | "credit_topup.create"
  | "subscription_checkout.create"
  | "billing_portal.create"
  | "auto_refill.update";
export type WorkflowStep = {
  id: string;
  title: string;
  // Workflow editor runtime token (e.g. "kimi-k2.6", "codex", "claude-code").
  model: string;
  // Concrete cloud-coding model selected when `model` is "codex" or "claude-code".
  runtimeModel?: AgentModelId;
  reasoningEffort?: CodexReasoningEffort;
  instructions: string;
};
export type SkillStatus = "draft" | "active";
// A skill imported from an external SKILL.md source. `null` on the row itself means
// hand-authored in opencompany. Matches `AgentRemoteSkillSource["type"]`
// (packages/agent-runtime/src/skill-resolver.ts) exactly — no translation layer needed.
export type SkillSourceType = "github" | "skills.sh";

export type HarnessEngine = "opencompany" | "codex" | "claude_code";

export type TaskStage =
  | "queued"
  | "planning"
  | "sandboxing"
  | "running"
  | "completed"
  | "failed"
  | "canceled";
export type TaskScheduleRunStatus = "pending" | "created" | "failed";
export type ChatSessionKind = "chat" | "task";
export type ChatModelRoutingTier = "standard" | "frontier";
export type ChatModelRoutingReason =
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
export type ChatModelRoutingOutcome = "success" | "skipped" | "timeout" | "error" | "invalid";
export type ChatModelRoutingErrorCategory =
  | "output_length"
  | "invalid_output"
  | "timeout"
  | "rate_limit"
  | "provider"
  | "unknown";

export type IntegrationProvider =
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
  | "imessage"
  | "x_account";
// Ownership is a property of the integration's binding, not a per-connect
// choice. Identity-bound connections (OAuth acting as a person: Gmail,
// Calendar, Slack user token, Linear, PostHog, Neon, X) are always personal. Installation-bound
// connections (GitHub App org installs, Jamie webhook secrets, the Slack
// answer-bot install) are workspace plumbing: they carry no human identity,
// must survive the connecting admin leaving, and are manageable by any
// workspace admin.
export const WORKSPACE_OWNED_INTEGRATION_PROVIDERS = [
  "github",
  "jamie",
  "slack_bot",
  "stripe",
] as const satisfies readonly IntegrationProvider[];
export function isWorkspaceOwnedIntegrationProvider(provider: IntegrationProvider) {
  return (WORKSPACE_OWNED_INTEGRATION_PROVIDERS as readonly IntegrationProvider[]).includes(
    provider,
  );
}
export type IntegrationStatus = "connected" | "needs_reauth" | "sync_failed" | "disconnected";
export type ImessageSendSource = "chat" | "task" | "pairing";
export type ImessageSendStatus = "sent" | "failed";
export type IntegrationCredentialKind = "oauth_token" | "webhook_secret" | "api_key";
export type IntegrationCredentialEncryptedPayload = EncryptedPayload;
export type BrowserProfileStatus = "pending_login" | "connected" | "needs_reauth" | "disconnected";
export type CodexCredentialStatus = "connected" | "needs_reauth";
export type CodexDeviceAuthFlowStatus =
  | "pending"
  | "code_ready"
  | "completed"
  | "failed"
  | "expired";
export type InfisicalConnectionStatus = "connected" | "needs_reauth" | "disconnected";
export type InfisicalAuthFlowStatus = "pending" | "link_ready" | "completed" | "failed" | "expired";
export type IntegrationResourceStatus =
  | "available"
  | "permission_lost"
  | "archived"
  | "sync_failed";
export type BrainSourceProvider =
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
export type BrainSourceConfigProvider =
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
export type BrainSourceType =
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
export type GoogleDriveWatchChannelStatus = "creating" | "active" | "stopped";
export type GmailMessageDirection = "sent" | "received";
export type SlackChannelType = "channel" | "group" | "im" | "mpim";
export type LinearEventEntityType = "issue" | "comment";
export type LinearEventAction = "create" | "update" | "remove";
export type GitHubPullRequestEventType =
  | "pull_request_opened"
  | "pull_request_merged"
  | "pull_request_commented";
export type HubspotObjectType = "contact" | "company" | "deal";
export type HubspotEventAction = "create" | "update";
export type AttioObjectType = "person" | "company" | "deal";
export type AttioEventAction = "create" | "update" | "note";
export type BrainSourceItemIngestStatus = "pending" | "succeeded" | "failed" | "skipped";
export type BrainIngestJobKind =
  | "brain_source_item_ingest"
  | "brain_agent_ingest"
  | "brain_pointer_hydrate";
export type BrainIngestJobStatus = "queued" | "running" | "succeeded" | "failed" | "skipped";
export type BrainImportStatus =
  | "discovering"
  | "awaiting_confirmation"
  | "ingesting"
  | "finalizing"
  | "succeeded"
  | "partial"
  | "failed"
  | "canceled";
export type BrainImportProvider =
  | "public_web"
  | "github"
  | "jamie"
  | "granola"
  | "fathom"
  | "gmail"
  | "slack"
  | "linear";
export type BrainImportSourceSelection = Partial<
  Record<
    BrainImportProvider,
    {
      enabled: boolean;
      integrationId?: string;
      config?: Record<string, unknown>;
    }
  >
>;
export type BrainImportProviderSummary = {
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
export type BrainImportDiscoverySummary = Partial<
  Record<BrainImportProvider, BrainImportProviderSummary>
>;

export type TaskToolName =
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

export type TaskSkillId = "first-principles" | "yc-office-hours";

export type TaskReportedOutcome = "done" | "needs_attention";

export type HarnessWorkflowStep = {
  index: number;
  title: string;
  engine: HarnessEngine;
  model: AgentModelId;
  reasoningEffort?: CodexReasoningEffort;
  systemPrompt: string;
  systemBlocks: string[];
  skillIds: string[];
};

export type HarnessSpec = {
  schemaVersion: "goat.harness.v1";
  engine: HarnessEngine;
  model: AgentModelId;
  systemPrompt: string;
  initialUserMessage: string;
  tools: TaskToolName[];
  skills: TaskSkillId[];
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
    steps?: HarnessWorkflowStep[];
    currentStepIndex?: number;
    completedStepCount?: number;
    lastCompletedStepOutcome?: {
      reportedOutcome: TaskReportedOutcome | null;
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

export type WorkspaceRole = "admin" | "member";
export type McpClient = "claude" | "chatgpt" | "cursor";
export type TaskViewMode = "board" | "list";
export type WorkspacePlan = "hobby" | "pro";
export type StripeSubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";
export type IngestionReservationStatus = "pending" | "consumed";
export type BrainIntelligence = "basic" | "frontier";
// "frontier_ingest" and "ingest_overage" are legacy v3 sources kept for
// historical rows; v4 writes "ingest_model_usage" (per attempt, all tiers)
// and "ingest_fee" (flat per-item fee at reservation admission).
export type CreditLedgerSource =
  | "starter_grant"
  | "seat_included_grant"
  | "seat_included_expiration"
  | "included_usage_grant"
  | "included_usage_expiration"
  | "stripe_topup"
  | "chat_model_usage"
  | "capability_usage"
  | "frontier_ingest"
  | "ingest_overage"
  | "ingest_model_usage"
  | "ingest_fee"
  | "adjustment";
export type ManagedCapabilitySource =
  | "x"
  | "linkedin"
  | "youtube"
  | "instagram"
  | "tiktok"
  | "lead"
  | "seo";
export type CapabilityRunStatus =
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
export type CheckoutSessionStatus = "pending" | "open" | "fulfilled" | "failed";
export type BrainVisibility = "workspace" | "restricted";
export type BrainFolderSource = "system" | "custom";
export type BrainEntityType =
  | "person"
  | "company"
  | "project"
  | "meeting"
  | "concept"
  | "source"
  | "analysis"
  | "note";
export type BrainKind = "page" | "evidence";
export type BrainRelation = {
  type: string;
  to: string;
};
export type BrainEdgeSourceKind = "relation" | "wiki_link";
export type BrainSource = {
  ref: string;
  title?: string;
  capturedAt?: string;
};
export type BrainDocumentFormat =
  | "markdown"
  | "pdf"
  | "docx"
  | "xlsx"
  | "srt"
  | "csv"
  | "tsv"
  | "json"
  | "text"
  | "image";
export type BrainStatus = "draft" | "active" | "archived" | "merged";
export type BrainFrontmatterProjection = Record<string, unknown>;
export type BrainTimelineEntry = {
  evidenceId: string;
  at: string;
  body: string;
};
export type BrainTimelineEntryRow = {
  evidenceId: string;
  at: string;
  summary: string;
  detail: string;
  sourceRef: string;
  sourceTitle?: string | null;
};
export type BrainDocumentVersionOperation = "overwrite" | "delete";

// Wiki (brain v2): one wiki per workspace, pages in a tree. A page's `slug` is
// its stable identity ([[wiki-links]] target slugs); `path` is its position as
// the slug chain of its ancestors plus itself. Mirrors @opencompany/wiki.
export type WikiKind = "project" | "person" | "company" | "research" | "meeting" | "other";
export type WikiPageFormat = BrainDocumentFormat;
export type WikiPageVersionOperation = "write" | "move" | "delete";
export type WikiLinkKind = "page" | "source";

export type TaskMessageRole = "user" | "assistant" | "tool";
export type TaskMessageStatus = "created" | "running" | "completed" | "failed";
export type TaskModelUsagePhase = "planner" | "execution";

export type TaskEventType =
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

export type TaskEventPayload = Record<string, unknown>;

export type TaskDebugTrace = {
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

export type ChatRole = "user" | "assistant";
export type ChatEngine = "opencompany" | "codex" | "claude_code";
export type ChatActivityState = "working" | "idle";
// Engines whose durable turns run through the legacy-named goat.codex_chat_* queue.
export type CodexChatEngine = ChatEngine;

export type ChatAttachmentKind =
  | "image"
  | "pdf"
  | "docx"
  | "xlsx"
  | "srt"
  | "csv"
  | "tsv"
  | "json"
  | "text";
export type ChatMessageAttachment = {
  id: string;
  kind: ChatAttachmentKind;
  mediaType: string;
  filename: string;
  sizeBytes: number;
  blobPathname: string;
  blobUrl: string;
};

export type CodexChatSessionStatus = ConversationRuntimeStatus;
export type CodexChatTurnStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "interrupted";
export const CODEX_APP_SERVER_EVENT_TYPES = [
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
export type CodexAppServerEventType = (typeof CODEX_APP_SERVER_EVENT_TYPES)[number];
export type CodexChatEventType = Exclude<
  CodexAppServerEventType,
  "assistant.delta" | "command.output"
>;
export const CODEX_CHAT_EVENT_TYPES: readonly CodexChatEventType[] =
  CODEX_APP_SERVER_EVENT_TYPES.filter(
    (eventType): eventType is CodexChatEventType =>
      eventType !== "assistant.delta" && eventType !== "command.output",
  );

export type CodexChatTurnSettings = {
  approvalContinuation?: boolean;
  mentions?: Array<{ kind: "skill"; id: string }>;
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

export type CodexChatInteractionStatus = "pending" | "resolved" | "canceled";

export type ChatMessageDebugTrace = {
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

export type BrainToolRunTrace = Record<string, unknown>;

export const productSchema = pgSchema("goat");
export const taskDisplayIdSequence = productSchema.sequence("task_display_id_seq");

export const users = productSchema.table(
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
    // Preview flag for the workspace wiki (brain v2). Gates the /wiki surface
    // and the `wiki` agent tool per user while brain keeps running unchanged.
    wikiEnabled: boolean("wiki_enabled").notNull().default(false),
    // Board vs list layout for the Tasks page; persisted per user across devices.
    taskViewMode: text("task_view_mode").notNull().default("board").$type<TaskViewMode>(),
    preferredMcpClient: text("preferred_mcp_client").$type<McpClient>(),
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

export const workspaces = productSchema.table(
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
      .references(() => users.workosUserId, { onDelete: "restrict" }),
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
export const onboarding = productSchema.table("onboarding", {
  userWorkosId: text("user_workos_id")
    .primaryKey()
    .references(() => users.workosUserId, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").references(() => workspaces.id, {
    onDelete: "set null",
  }),
  referralSource: text("referral_source"),
  // Self-reported profile captured on the first onboarding step. `role` is one
  // of the ROLE_PROFILES ids in the wizard and seeds the tailored brain folders.
  role: text("role"),
  // Legacy free-text field retained for existing rows. New opencompany onboarding
  // stores the normalized hostname in companyDomain and the homepage URL in
  // contextUrls.
  building: text("building"),
  companyDomain: text("company_domain"),
  contextUrls: jsonb("context_urls").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OnboardingEmailStep = "welcome" | "checkin" | "feedback_call";
export type OnboardingEmailStatus = "pending" | "sending" | "sent" | "failed" | "skipped";

// One row per (owner, step) of the founder onboarding drip. Enrollment inserts
// three rows at first-workspace creation; a cron sweep claims due `pending` rows
// (status flips to `sending` under a soft lease), sends via Resend, then marks
// `sent`. The unique (user, step) index makes enrollment idempotent and gives
// each send a stable Resend idempotency key. Only owners are enrolled — invited
// members never reach the create-workspace branch that triggers it.
export const onboardingEmails = productSchema.table(
  "onboarding_emails",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workosUserId: text("workos_user_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    step: text("step").$type<OnboardingEmailStep>().notNull(),
    status: text("status").$type<OnboardingEmailStatus>().notNull().default("pending"),
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

export const workspaceMembers = productSchema.table(
  "workspace_members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    role: text("role").$type<WorkspaceRole>().notNull().default("member"),
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

// opencompany-managed paid capabilities are workspace features, not user
// integrations. Missing rows mean enabled; this table stores only explicit
// workspace overrides.
export const workspaceCapabilities = productSchema.table(
  "workspace_capabilities",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    source: text("source").$type<ManagedCapabilitySource>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedByWorkosId: text("updated_by_workos_id").references(() => users.workosUserId, {
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
export const workspaceBilling = productSchema.table(
  "workspace_billing",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    plan: text("plan").$type<WorkspacePlan>().notNull().default("hobby"),
    planStartedAt: timestamp("plan_started_at", { withTimezone: true }).notNull().defaultNow(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripeSubscriptionItemId: text("stripe_subscription_item_id"),
    stripePriceId: text("stripe_price_id"),
    stripeProductKey: text("stripe_product_key"),
    subscriptionStatus: text("subscription_status").$type<StripeSubscriptionStatus>(),
    seatQuantity: integer("seat_quantity").notNull().default(1),
    includedUsagePeriodStart: timestamp("included_usage_period_start", { withTimezone: true }),
    includedUsagePeriodEnd: timestamp("included_usage_period_end", { withTimezone: true }),
    includedUsageAllowanceCents: integer("included_usage_allowance_cents").notNull().default(0),
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
    planCheck: check("goat_workspace_billing_plan_check", sql`${table.plan} IN ('hobby', 'pro')`),
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

export const stripeWebhookEvents = productSchema.table("stripe_webhook_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  eventCreatedAt: timestamp("event_created_at", { withTimezone: true }).notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

// USD credit balance per workspace. balance_usd_micros remains the aggregate
// used by gates and dashboards; billing v7 also tracks the monthly included pool
// separately from top-up funds so debits can draw included usage first
// and expire unused included usage monthly without touching top-ups.
export const creditBalances = productSchema.table("credit_balances", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
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
export const stripeCheckoutSessions = productSchema.table(
  "stripe_checkout_sessions",
  {
    id: text("id").primaryKey(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id").references(() => users.workosUserId, {
      onDelete: "set null",
    }),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").$type<CheckoutSessionStatus>().notNull().default("pending"),
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
export const creditLedger = productSchema.table(
  "credit_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id").references(() => users.workosUserId, {
      onDelete: "set null",
    }),
    amountCents: integer("amount_cents").notNull(),
    amountUsdMicros: bigint("amount_usd_micros", { mode: "number" }).notNull().default(0),
    source: text("source").$type<CreditLedgerSource>().notNull(),
    idempotencyKey: text("idempotency_key"),
    checkoutSessionId: text("checkout_session_id").references(() => stripeCheckoutSessions.id, {
      onDelete: "set null",
    }),
    chatSessionId: text("chat_session_id").references(() => chatSessions.id, {
      onDelete: "set null",
    }),
    ingestJobId: text("ingest_job_id").references(() => brainIngestJobs.id, {
      onDelete: "set null",
    }),
    reservationId: text("reservation_id").references(() => workspaceIngestionReservations.id, {
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
      sql`${table.source} IN ('starter_grant', 'seat_included_grant', 'seat_included_expiration', 'included_usage_grant', 'included_usage_expiration', 'stripe_topup', 'chat_model_usage', 'capability_usage', 'frontier_ingest', 'ingest_overage', 'ingest_model_usage', 'ingest_fee', 'adjustment')`,
    ),
  }),
);

// Naming convention: on the brain content tables below, `brain_id` is the
// DOCUMENT slug (legacy name, e.g. "alice-smith"), while `brain_ref` is the
// FK to `goat.brains.id` — the brain a row belongs to.
export const brains = productSchema.table(
  "brains",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    visibility: text("visibility").$type<BrainVisibility>().notNull().default("workspace"),
    // When true, the ingestion agent may use web search to enrich confidently
    // identified people, companies, and projects. Owner escape-hatch; the real
    // safety is the identity gate + per-ingest search cap in the runner.
    enrichmentEnabled: boolean("enrichment_enabled").notNull().default(true),
    // Which model tier the ingestion agent runs for this brain. "basic"
    // (open-source model) is included in the plan; "frontier" (Claude Sonnet)
    // passes model cost through to the workspace's credit balance.
    intelligence: text("intelligence").$type<BrainIntelligence>().notNull().default("basic"),
    createdByWorkosId: text("created_by_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "restrict" }),
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

export const brainImportRuns = productSchema.table(
  "brain_import_runs",
  {
    id: text("id").primaryKey(),
    brainRef: text("brain_ref")
      .notNull()
      .references(() => brains.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    companyUrl: text("company_url").notNull(),
    companyDomain: text("company_domain").notNull(),
    companyName: text("company_name"),
    focus: text("focus"),
    historyStartAt: timestamp("history_start_at", {
      withTimezone: true,
    }).notNull(),
    historyEndAt: timestamp("history_end_at", { withTimezone: true }).notNull(),
    sourceSelection: jsonb("source_selection")
      .$type<BrainImportSourceSelection>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    discoverySummary: jsonb("discovery_summary")
      .$type<BrainImportDiscoverySummary>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    status: text("status").$type<BrainImportStatus>().notNull().default("discovering"),
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

export const brainMembers = productSchema.table(
  "brain_members",
  {
    id: text("id").primaryKey(),
    brainId: text("brain_id")
      .notNull()
      .references(() => brains.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
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

export const brainFolders = productSchema.table(
  "brain_folders",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    brainRef: text("brain_ref")
      .notNull()
      .references(() => brains.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    path: text("path").notNull(),
    source: text("source").$type<BrainFolderSource>().notNull().default("custom"),
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

export const brainDocuments = productSchema.table(
  "brain_documents",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    // Who originally put this document in the brain (set once at insert, never
    // on update — unlike userWorkosId, which tracks the last actor). Null when
    // no human originated it, e.g. Slack-window ingestion: the integration
    // owner connected the channel but did not author its content.
    createdByWorkosId: text("created_by_workos_id").references(() => users.workosUserId, {
      onDelete: "set null",
    }),
    brainRef: text("brain_ref")
      .notNull()
      .references(() => brains.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    brainId: text("brain_id").notNull(),
    folderPath: text("folder_path").notNull(),
    title: text("title"),
    content: text("content").notNull().default(""),
    body: text("body").notNull().default(""),
    timeline: jsonb("timeline").$type<BrainTimelineEntry[]>().notNull().default(sql`'[]'::jsonb`),
    format: text("format").$type<BrainDocumentFormat>().notNull().default("markdown"),
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
    relations: jsonb("relations").$type<BrainRelation[]>().notNull().default(sql`'[]'::jsonb`),
    sources: jsonb("sources").$type<BrainSource[]>().notNull().default(sql`'[]'::jsonb`),
    kind: text("kind").$type<BrainKind>().notNull(),
    entityType: text("entity_type").$type<BrainEntityType>().notNull(),
    status: text("status").$type<BrainStatus>().notNull().default("draft"),
    aliases: jsonb("aliases").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    // Retrieval projections: `search_text` (title + aliases + compiled truth + timeline + relation
    // text) feeds the generated FTS vector; `name_text` (title + aliases) feeds trigram entity
    // lookup. Both are composed in documentValues() (brain-files.ts).
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
      sql`${table.format} IN ('markdown', 'pdf', 'docx', 'xlsx', 'srt', 'csv', 'tsv', 'json', 'text', 'image')`,
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

export const brainTimelineEntries = productSchema.table(
  "brain_timeline_entries",
  {
    id: serial("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => brainDocuments.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    brainRef: text("brain_ref")
      .notNull()
      .references(() => brains.id, {
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

export const brainEdges = productSchema.table(
  "brain_edges",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    brainRef: text("brain_ref")
      .notNull()
      .references(() => brains.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    documentId: text("document_id")
      .notNull()
      .references(() => brainDocuments.id, { onDelete: "cascade" }),
    fromBrainId: text("from_brain_id").notNull(),
    toBrainId: text("to_brain_id").notNull(),
    relationType: text("relation_type").notNull(),
    sourceKind: text("source_kind").$type<BrainEdgeSourceKind>().notNull(),
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
// re-embedded write-through at query time (brain-read.ts). Rebuildable projection — safe to
// truncate.
export const brainDocumentEmbeddings = productSchema.table(
  "brain_document_embeddings",
  {
    documentId: text("document_id")
      .primaryKey()
      .references(() => brainDocuments.id, { onDelete: "cascade" }),
    brainRef: text("brain_ref")
      .notNull()
      .references(() => brains.id, {
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

export const brainDocumentVersions = productSchema.table(
  "brain_document_versions",
  {
    id: serial("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    brainRef: text("brain_ref").references(() => brains.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    documentId: text("document_id").references(() => brainDocuments.id, {
      onDelete: "set null",
    }),
    taskId: text("task_id"),
    importRunId: text("import_run_id").references(() => brainImportRuns.id, {
      onDelete: "set null",
    }),
    brainId: text("brain_id").notNull(),
    folderPath: text("folder_path").notNull(),
    content: text("content").notNull().default(""),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    operation: text("operation").$type<BrainDocumentVersionOperation>().notNull(),
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

export const integrations = productSchema.table(
  "integrations",
  {
    id: text("id").primaryKey(),
    // The user who connected this integration. For personal integrations this
    // is the owner; for workspace-owned rows it is attribution only (the
    // credential AAD is also keyed on it, so it stays set either way).
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    // Set for workspace-owned integrations (installation-bound providers:
    // GitHub, Jamie, Slack bot, Stripe). NULL = personal integration owned by
    // user_workos_id.
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    // Foundation for offering a personal integration to workspace admins as a
    // brain-source option without transferring ownership. No UI yet.
    sharedWithWorkspace: boolean("shared_with_workspace").notNull().default(false),
    provider: text("provider").$type<IntegrationProvider>().notNull(),
    externalId: text("external_id").notNull(),
    connectionLabel: text("connection_label"),
    accountName: text("account_name"),
    accountEmail: text("account_email"),
    accountType: text("account_type"),
    status: text("status").$type<IntegrationStatus>().notNull().default("connected"),
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
      sql`${table.provider} IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude', 'posthog', 'neon', 'imessage', 'x_account')`,
    ),
    statusCheck: check(
      "goat_integrations_status_check",
      sql`${table.status} IN ('connected', 'needs_reauth', 'sync_failed', 'disconnected')`,
    ),
  }),
);

export const integrationCredentials = productSchema.table(
  "integration_credentials",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    integrationId: text("integration_id").notNull(),
    provider: text("provider").$type<IntegrationProvider>().notNull(),
    kind: text("kind").$type<IntegrationCredentialKind>().notNull(),
    encryptedPayload: jsonb("encrypted_payload")
      .$type<IntegrationCredentialEncryptedPayload>()
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
      foreignColumns: [integrations.id, integrations.userWorkosId, integrations.provider],
    }).onDelete("cascade"),
    providerCheck: check(
      "goat_integration_credentials_provider_check",
      sql`${table.provider} IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude', 'posthog', 'neon', 'imessage', 'x_account')`,
    ),
    kindCheck: check(
      "goat_integration_credentials_kind_check",
      sql`${table.kind} IN ('oauth_token', 'webhook_secret', 'api_key')`,
    ),
  }),
);

export const integrationResources = productSchema.table(
  "integration_resources",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    integrationId: text("integration_id").notNull(),
    provider: text("provider").$type<IntegrationProvider>().notNull(),
    resourceType: text("resource_type").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    displayName: text("display_name"),
    status: text("status").$type<IntegrationResourceStatus>().notNull().default("available"),
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
      foreignColumns: [integrations.id, integrations.userWorkosId, integrations.provider],
    }).onDelete("cascade"),
    providerCheck: check(
      "goat_integration_resources_provider_check",
      sql`${table.provider} IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'hubspot', 'granola', 'fathom', 'attio', 'stripe', 'latitude', 'posthog', 'neon', 'imessage', 'x_account')`,
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
export const imessagePairingChallenges = productSchema.table(
  "imessage_pairing_challenges",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
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
export const imessageSends = productSchema.table(
  "imessage_sends",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    source: text("source").$type<ImessageSendSource>().notNull(),
    chatSessionId: text("chat_session_id"),
    turnId: text("turn_id"),
    status: text("status").$type<ImessageSendStatus>().notNull(),
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
export const brainSources = productSchema.table(
  "brain_sources",
  {
    id: text("id").primaryKey(),
    brainId: text("brain_id")
      .notNull()
      .references(() => brains.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    provider: text("provider").$type<BrainSourceConfigProvider>().notNull(),
    integrationId: text("integration_id").notNull(),
    // user_workos_id of the referenced integration row (its owner for personal
    // integrations, the connecting admin for workspace-owned ones). Part of the
    // composite FK below, so it must mirror the integration row exactly.
    userWorkosId: text("user_workos_id").notNull(),
    createdByWorkosId: text("created_by_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
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
      foreignColumns: [integrations.id, integrations.userWorkosId, integrations.provider],
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
export const brainSourceEventClaims = productSchema.table(
  "brain_source_event_claims",
  {
    id: text("id").primaryKey(),
    brainId: text("brain_id")
      .notNull()
      .references(() => brains.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    sourceProvider: text("source_provider").notNull(),
    eventKey: text("event_key").notNull(),
    sourceItemId: text("source_item_id").references(() => brainSourceItems.id, {
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

export const brainSourceItems = productSchema.table(
  "brain_source_items",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    sourceProvider: text("source_provider").$type<BrainSourceProvider>().notNull(),
    sourceConnectionId: text("source_connection_id").notNull(),
    integrationId: text("integration_id"),
    sourceType: text("source_type").$type<BrainSourceType>().notNull(),
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
    lastIngestStatus: text("last_ingest_status").$type<BrainSourceItemIngestStatus>(),
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
      foreignColumns: [integrations.id, integrations.userWorkosId, integrations.provider],
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

export const brainIngestJobs = productSchema.table(
  "brain_ingest_jobs",
  {
    id: text("id").primaryKey(),
    sourceItemId: text("source_item_id")
      .notNull()
      .references(() => brainSourceItems.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    sourceProvider: text("source_provider").$type<BrainSourceProvider>().notNull(),
    sourceConnectionId: text("source_connection_id").notNull(),
    integrationId: text("integration_id"),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    importRunId: text("import_run_id").references(() => brainImportRuns.id, {
      onDelete: "set null",
    }),
    // Target brain for the job (principle: ingestion is per-brain). Null means
    // the handler resolves the user's default brain at run time.
    brainRef: text("brain_ref").references(() => brains.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    kind: text("kind").$type<BrainIngestJobKind>().notNull(),
    contentHash: text("content_hash").notNull(),
    status: text("status").$type<BrainIngestJobStatus>().notNull().default("queued"),
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
export const workspaceIngestionReservations = productSchema.table(
  "workspace_ingestion_reservations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceItemId: text("source_item_id")
      .notNull()
      .references(() => brainSourceItems.id, { onDelete: "cascade" }),
    sourceProvider: text("source_provider").$type<BrainSourceProvider>().notNull(),
    rawEventCount: integer("raw_event_count").notNull(),
    status: text("status").$type<IngestionReservationStatus>().notNull().default("pending"),
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

export const brainImportCandidates = productSchema.table(
  "brain_import_candidates",
  {
    id: text("id").primaryKey(),
    importRunId: text("import_run_id")
      .notNull()
      .references(() => brainImportRuns.id, { onDelete: "cascade" }),
    provider: text("provider").$type<BrainImportProvider>().notNull(),
    sourceItemId: text("source_item_id")
      .notNull()
      .references(() => brainSourceItems.id, { onDelete: "cascade" }),
    ingestJobId: text("ingest_job_id").references(() => brainIngestJobs.id, {
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

// ---------------------------------------------------------------------------
// Wiki (brain v2). One wiki per workspace — pages hang directly off the
// workspace, there is no container table. See packages/wiki for the
// domain rules these tables store.
// ---------------------------------------------------------------------------

export const wikiPages = productSchema.table(
  "wiki_pages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Stable identity, unique per workspace; [[wiki-links]] target slugs so
    // links survive restructuring.
    slug: text("slug").notNull(),
    // Tree position: ancestor slug chain plus own slug ("projects/site").
    // Invariant (app-enforced): the last path segment equals `slug`.
    path: text("path").notNull(),
    // Display title derived from the body's first H1 (fallback: slug). Never identity.
    title: text("title").notNull().default(""),
    kind: text("kind").$type<WikiKind>().notNull().default("other"),
    // Markdown body WITHOUT frontmatter. The `kind:` frontmatter block is a
    // serialization detail of the sandbox filesystem projection.
    content: text("content").notNull().default(""),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    // Binary-backed pages (uploads). Markdown pages leave these null.
    format: text("format").$type<WikiPageFormat>().notNull().default("markdown"),
    mimeType: text("mime_type"),
    originalFileName: text("original_file_name"),
    assetStorageKey: text("asset_storage_key"),
    // Machine-extracted text of the binary asset; regenerated, never user-edited.
    assetExtractedText: text("asset_extracted_text"),
    assetContentHash: text("asset_content_hash"),
    assetSizeBytes: integer("asset_size_bytes"),
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('english', coalesce("title", '') || ' ' || coalesce("content", '') || ' ' || coalesce("asset_extracted_text", ''))`,
    ),
    createdByWorkosId: text("created_by_workos_id").references(() => users.workosUserId, {
      onDelete: "set null",
    }),
    updatedByWorkosId: text("updated_by_workos_id").references(() => users.workosUserId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceSlugIdx: uniqueIndex("goat_wiki_pages_workspace_slug_idx").on(
      table.workspaceId,
      table.slug,
    ),
    workspacePathIdx: uniqueIndex("goat_wiki_pages_workspace_path_idx").on(
      table.workspaceId,
      table.path,
    ),
    workspaceUpdatedIdx: index("goat_wiki_pages_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt,
    ),
    searchTsvIdx: index("goat_wiki_pages_search_tsv_idx").using("gin", table.searchTsv),
    titleTrgmIdx: index("goat_wiki_pages_title_trgm_idx").using(
      "gin",
      table.title.op("gin_trgm_ops"),
    ),
    kindCheck: check(
      "goat_wiki_pages_kind_check",
      sql`${table.kind} IN ('project', 'person', 'company', 'research', 'meeting', 'other')`,
    ),
    formatCheck: check(
      "goat_wiki_pages_format_check",
      sql`${table.format} IN ('markdown', 'pdf', 'docx', 'xlsx', 'srt', 'csv', 'tsv', 'json', 'text', 'image')`,
    ),
  }),
);

// Append-only history. Survives page deletion (page_id goes null) and powers
// undo plus the `recent` change feed; line deltas are computed at write time
// against the previous version so `recent` is a pure aggregation.
export const wikiPageVersions = productSchema.table(
  "wiki_page_versions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    pageId: text("page_id").references(() => wikiPages.id, { onDelete: "set null" }),
    slug: text("slug").notNull(),
    path: text("path").notNull(),
    title: text("title").notNull().default(""),
    kind: text("kind").$type<WikiKind>().notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    operation: text("operation").$type<WikiPageVersionOperation>().notNull(),
    addedLines: integer("added_lines").notNull().default(0),
    removedLines: integer("removed_lines").notNull().default(0),
    actorWorkosId: text("actor_workos_id").references(() => users.workosUserId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceCreatedIdx: index("goat_wiki_page_versions_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    pageCreatedIdx: index("goat_wiki_page_versions_page_created_idx").on(
      table.pageId,
      table.createdAt,
    ),
    operationCheck: check(
      "goat_wiki_page_versions_operation_check",
      sql`${table.operation} IN ('write', 'move', 'delete')`,
    ),
  }),
);

// Dated one-liners attached to a page, kept OUT of the markdown body so agents
// only pay for timeline tokens when they explicitly ask for it and TipTap
// editing stays plain markdown. `text` is markdown and may carry [[links]].
export const wikiTimelineEntries = productSchema.table(
  "wiki_timeline_entries",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    pageId: text("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull(),
    text: text("text").notNull(),
    createdByWorkosId: text("created_by_workos_id").references(() => users.workosUserId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pageAtIdx: index("goat_wiki_timeline_entries_page_at_idx").on(table.pageId, table.at),
    workspaceAtIdx: index("goat_wiki_timeline_entries_workspace_at_idx").on(
      table.workspaceId,
      table.at,
    ),
  }),
);

// Derived link index, rebuilt from a page's body on every write. `target` is a
// page slug (kind='page' — target page need not exist yet) or a source ref
// (kind='source', e.g. "linear:issue:ENG-123"). Never edited directly; powers
// backlinks and per-page source listings.
export const wikiLinks = productSchema.table(
  "wiki_links",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    fromPageId: text("from_page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    kind: text("kind").$type<WikiLinkKind>().notNull(),
    target: text("target").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    fromKindTargetIdx: uniqueIndex("goat_wiki_links_from_kind_target_idx").on(
      table.fromPageId,
      table.kind,
      table.target,
    ),
    workspaceKindTargetIdx: index("goat_wiki_links_workspace_kind_target_idx").on(
      table.workspaceId,
      table.kind,
      table.target,
    ),
    kindCheck: check("goat_wiki_links_kind_check", sql`${table.kind} IN ('page', 'source')`),
  }),
);

// Durable delivery lease for Slack answer-bot events. Slack can retry a failed
// HTTP delivery while the original after() task is still running, so event_id
// is claimed before scheduling work and can be reclaimed only after the task's
// maximum runtime has elapsed.
export const slackBotEventClaims = productSchema.table("slack_bot_event_claims", {
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
export const slackBotThreadParticipation = productSchema.table(
  "slack_bot_thread_participation",
  {
    teamId: text("team_id").notNull(),
    channelId: text("channel_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
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
export const slackMessageEvents = productSchema.table(
  "slack_message_events",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    channelId: text("channel_id").notNull(),
    channelType: text("channel_type").$type<SlackChannelType>().notNull(),
    messageTs: text("message_ts").notNull(),
    threadTs: text("thread_ts"),
    slackUserId: text("slack_user_id"),
    subtype: text("subtype"),
    text: text("text").notNull().default(""),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    sourceItemId: text("source_item_id").references(() => brainSourceItems.id, {
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
export const linearIssueEvents = productSchema.table(
  "linear_issue_events",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    // Nullable: comment events do not always carry the issue's team; the flush
    // worker re-resolves the team from the live issue snapshot.
    teamId: text("team_id"),
    issueId: text("issue_id").notNull(),
    // One webhook delivery may buffer for several integrations of the same
    // Linear organization; the delivery id makes redeliveries per-integration no-ops.
    deliveryId: text("delivery_id").notNull(),
    entityType: text("entity_type").$type<LinearEventEntityType>().notNull(),
    action: text("action").$type<LinearEventAction>().notNull(),
    issueTitle: text("issue_title"),
    actorName: text("actor_name"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    sourceItemId: text("source_item_id").references(() => brainSourceItems.id, {
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
export const gitHubPullRequestEvents = productSchema.table(
  "github_pull_request_events",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    pullRequestNumber: integer("pull_request_number").notNull(),
    // GitHub's X-GitHub-Delivery UUID is stable across redelivery attempts.
    deliveryId: text("delivery_id").notNull(),
    eventType: text("event_type").$type<GitHubPullRequestEventType>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    sourceItemId: text("source_item_id").references(() => brainSourceItems.id, {
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
export const hubspotObjectEvents = productSchema.table(
  "hubspot_object_events",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    portalId: text("portal_id").notNull(),
    objectType: text("object_type").$type<HubspotObjectType>().notNull(),
    objectId: text("object_id").notNull(),
    // One webhook delivery may buffer for several integrations of the same
    // HubSpot portal; the event id makes redeliveries per-integration no-ops.
    deliveryId: text("delivery_id").notNull(),
    action: text("action").$type<HubspotEventAction>().notNull(),
    // Set for property-change events; flush classification reads it without
    // re-parsing the payload.
    propertyName: text("property_name"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    sourceItemId: text("source_item_id").references(() => brainSourceItems.id, {
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
export const attioObjectEvents = productSchema.table(
  "attio_object_events",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    objectType: text("object_type").$type<AttioObjectType>().notNull(),
    recordId: text("record_id").notNull(),
    // Attio deliveries carry no delivery id; the receiver synthesizes one that
    // is stable for note/create events so redeliveries are per-integration
    // no-ops (update events coalesce in the window instead).
    deliveryId: text("delivery_id").notNull(),
    action: text("action").$type<AttioEventAction>().notNull(),
    // Set for attribute-change events; flush enrichment resolves the attribute
    // name without re-parsing the payload.
    attributeId: text("attribute_id"),
    // Set for note.created events; the flush worker fetches note content.
    noteId: text("note_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    sourceItemId: text("source_item_id").references(() => brainSourceItems.id, {
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
export const gmailMessageEvents = productSchema.table(
  "gmail_message_events",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    messageId: text("message_id").notNull(),
    // RFC822 Message-ID header — the only cross-mailbox identity for an email
    // (Gmail message ids are per-mailbox). Used for cross-member brain dedup;
    // NULL for rows buffered before capture shipped or when the header is absent.
    rfc822MessageId: text("rfc822_message_id"),
    // Classified at poll time from labelIds (SENT label); flush routing matches
    // brain-source event filters against this without re-parsing labels.
    direction: text("direction").$type<GmailMessageDirection>().notNull(),
    subject: text("subject"),
    fromHeader: text("from_header"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    sourceItemId: text("source_item_id").references(() => brainSourceItems.id, {
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
export const gmailSyncState = productSchema.table("gmail_sync_state", {
  integrationId: text("integration_id")
    .primaryKey()
    .references(() => integrations.id, { onDelete: "cascade" }),
  userWorkosId: text("user_workos_id")
    .notNull()
    .references(() => users.workosUserId, { onDelete: "cascade" }),
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
export const granolaSyncState = productSchema.table("granola_sync_state", {
  integrationId: text("integration_id")
    .primaryKey()
    .references(() => integrations.id, { onDelete: "cascade" }),
  userWorkosId: text("user_workos_id")
    .notNull()
    .references(() => users.workosUserId, { onDelete: "cascade" }),
  updatedAfterCursor: timestamp("updated_after_cursor", { withTimezone: true }),
  pageCursor: text("page_cursor"),
  pendingUpdatedAfterCursor: timestamp("pending_updated_after_cursor", { withTimezone: true }),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-integration Fathom poll cursor. opencompany uses bounded created_after /
// created_before windows for personal API-key connections. The initial cursor
// is written when the connection is created, so live ingestion never backfills
// implicitly. pending_created_before_cursor pins the upper bound while an
// opaque page_cursor continuation is in flight.
export const fathomSyncState = productSchema.table("fathom_sync_state", {
  integrationId: text("integration_id")
    .primaryKey()
    .references(() => integrations.id, { onDelete: "cascade" }),
  userWorkosId: text("user_workos_id")
    .notNull()
    .references(() => users.workosUserId, { onDelete: "cascade" }),
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
export const fathomPendingMeetings = productSchema.table(
  "fathom_pending_meetings",
  {
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    recordingId: text("recording_id").notNull(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
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
export const googleDriveSyncCursors = productSchema.table(
  "google_drive_sync_cursors",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
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
export const googleDriveWatchChannels = productSchema.table(
  "google_drive_watch_channels",
  {
    id: text("id").primaryKey(),
    cursorId: text("cursor_id")
      .notNull()
      .references(() => googleDriveSyncCursors.id, { onDelete: "cascade" }),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    resourceId: text("resource_id"),
    tokenHash: text("token_hash").notNull(),
    status: text("status").$type<GoogleDriveWatchChannelStatus>().notNull().default("creating"),
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
export const googleDriveFileStates = productSchema.table(
  "google_drive_file_states",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
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
    lastSourceItemId: text("last_source_item_id").references(() => brainSourceItems.id, {
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

export const taskSchedules = productSchema.table(
  "task_schedules",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    sourceDescription: text("source_description").notNull().default(""),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    prompt: text("prompt").notNull(),
    plannedHarnessSpec: jsonb("planned_harness_spec").$type<HarnessSpec>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
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
    workspaceNextRunIdx: index("goat_task_schedules_workspace_next_run_idx").on(
      table.workspaceId,
      table.nextRunAt,
    ),
  }),
);

// Workspace-scoped automations. Formerly stored as markdown documents in a
// reserved `workflows/` Brain folder; extracted here so "how work happens" is a
// first-class, company-level primitive rather than Brain (knowledge) content.
// `slug` is the stable handle used by the `#` composer mention and persisted as
// `tasks.workflow_id` when a workflow fires.
export const workflows = productSchema.table(
  "workflows",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    // Engine/model token from the editor's Model dropdown (e.g. "kimi-k2.6",
    // "codex"); empty when the workflow has not picked one explicitly.
    model: text("model").notNull().default(""),
    steps: jsonb("steps").$type<WorkflowStep[]>().notNull().default(sql`'[]'::jsonb`),
    trigger: text("trigger").$type<WorkflowTrigger>().notNull().default("manual"),
    scheduleCron: text("schedule_cron"),
    scheduleTimezone: text("schedule_timezone").notNull().default("UTC"),
    schedulePrompt: text("schedule_prompt").notNull().default(""),
    scheduleUserWorkosId: text("schedule_user_workos_id").references(() => users.workosUserId, {
      onDelete: "set null",
    }),
    scheduleHarnessSpec: jsonb("schedule_harness_spec").$type<HarnessSpec | null>(),
    scheduleEnabled: boolean("schedule_enabled").notNull().default(false),
    scheduleLastRunAt: timestamp("schedule_last_run_at", { withTimezone: true }),
    scheduleNextRunAt: timestamp("schedule_next_run_at", { withTimezone: true }),
    status: text("status").$type<WorkflowStatus>().notNull().default("active"),
    createdByWorkosId: text("created_by_workos_id").references(() => users.workosUserId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
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
// still snapshots its content immutably into `chatSessionSkills`.
export const skills = productSchema.table(
  "skills",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    status: text("status").$type<SkillStatus>().notNull().default("draft"),
    createdByWorkosId: text("created_by_workos_id").references(() => users.workosUserId, {
      onDelete: "set null",
    }),
    // Source provenance for imported skills. NULL sourceType = hand-authored in opencompany (the
    // original, still-supported path). Non-NULL means the row was resolved from an external
    // SKILL.md and is read-only — enforced by PostgresKnowledgeRepository.updateSkill.
    sourceType: text("source_type").$type<SkillSourceType>(),
    sourceUrl: text("source_url"),
    sourceRef: text("source_ref"),
    sourcePath: text("source_path"),
    resolvedCommit: text("resolved_commit"),
    integrity: text("integrity"),
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
    // Prevents importing the same skill twice into one workspace. The canonical repository
    // returns the existing row for a matching resolved source.
    workspaceSourceIdx: uniqueIndex("goat_skills_workspace_source_idx")
      .on(table.workspaceId, table.sourceUrl, table.sourceRef, table.sourcePath)
      .where(sql`${table.sourceType} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    statusCheck: check("goat_skills_status_check", sql`${table.status} IN ('draft', 'active')`),
    sourceTypeCheck: check(
      "goat_skills_source_type_check",
      sql`${table.sourceType} IS NULL OR ${table.sourceType} IN ('github', 'skills.sh')`,
    ),
    sourceUrlRequiredCheck: check(
      "goat_skills_source_url_required_check",
      sql`${table.sourceType} IS NULL OR ${table.sourceUrl} IS NOT NULL`,
    ),
  }),
);

// Workspace-shared bootstrap material for repositories used by the repo-agnostic
// Codex and Claude Code chat sandboxes. Environment contents are encrypted at
// rest; envKeys is intentionally limited to plaintext key names for settings UI.
export const repoConfigs = productSchema.table(
  "repo_configs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repositoryExternalId: text("repository_external_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    encryptedEnvPayload: jsonb("encrypted_env_payload").$type<EncryptedPayload>(),
    encryptionKeyVersion: integer("encryption_key_version"),
    envKeys: jsonb("env_keys").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    setupInstructions: text("setup_instructions").notNull().default(""),
    createdByWorkosId: text("created_by_workos_id").references(() => users.workosUserId, {
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

export const tasks = productSchema.table(
  "tasks",
  {
    id: text("id").primaryKey(),
    displayId: text("display_id")
      .notNull()
      .default(sql`'TASK-' || nextval('goat.task_display_id_seq')::text`),
    name: text("name").notNull().default("Untitled task"),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    prompt: text("prompt").notNull(),
    source: text("source").$type<TaskSource>().notNull().default("manual"),
    model: text("model").$type<AgentModelId>().notNull(),
    sessionId: text("session_id").references(() => chatSessions.id, {
      onDelete: "set null",
    }),
    scheduleId: text("schedule_id").references(() => taskSchedules.id, {
      onDelete: "set null",
    }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    status: text("status").$type<TaskStatus>().notNull().default("queued"),
    stage: text("stage").$type<TaskStage>().notNull().default("queued"),
    result: text("result"),
    error: text("error"),
    workflowId: text("workflow_id"),
    workflowBrainRef: text("workflow_brain_ref"),
    reportedOutcome: text("reported_outcome").$type<TaskReportedOutcome>(),
    outcomeComment: text("outcome_comment"),
    harnessSpec: jsonb("harness_spec").$type<HarnessSpec>().notNull().default(sql`'{}'::jsonb`),
    debugTrace: jsonb("debug_trace").$type<TaskDebugTrace>().notNull().default(sql`'{}'::jsonb`),
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
    sourceCheck: check(
      "goat_tasks_source_check",
      sql`${table.source} IN (${sql.join(
        TASK_SOURCES.map((source) => sql`${source}`),
        sql`, `,
      )})`,
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

export const taskScheduleRuns = productSchema.table(
  "task_schedule_runs",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => taskSchedules.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    taskId: text("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    status: text("status").$type<TaskScheduleRunStatus>().notNull().default("pending"),
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

export const workflowScheduleRuns = productSchema.table(
  "workflow_schedule_runs",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    taskId: text("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    status: text("status").$type<TaskScheduleRunStatus>().notNull().default("pending"),
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

export const taskMessages = productSchema.table(
  "task_messages",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    role: text("role").$type<TaskMessageRole>().notNull(),
    status: text("status").$type<TaskMessageStatus>().notNull().default("created"),
    content: text("content").notNull().default(""),
    modelMessage: jsonb("model_message").$type<unknown>(),
    toolName: text("tool_name").$type<TaskToolName>(),
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

export const taskEvents = productSchema.table(
  "task_events",
  {
    id: serial("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => taskMessages.id, {
      onDelete: "set null",
    }),
    type: text("type").$type<TaskEventType>().notNull(),
    payload: jsonb("payload").$type<TaskEventPayload>().notNull().default(sql`'{}'::jsonb`),
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

export const taskModelUsage = productSchema.table(
  "task_model_usage",
  {
    id: serial("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => taskMessages.id, {
      onDelete: "set null",
    }),
    runLeaseId: text("run_lease_id"),
    phase: text("phase").$type<TaskModelUsagePhase>().notNull(),
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

export const taskToolUsage = productSchema.table(
  "task_tool_usage",
  {
    id: serial("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => taskMessages.id, {
      onDelete: "set null",
    }),
    runLeaseId: text("run_lease_id"),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").$type<TaskToolName>().notNull(),
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

export const taskSandboxUsage = productSchema.table(
  "task_sandbox_usage",
  {
    id: serial("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => taskMessages.id, {
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

export const chatSessions = productSchema.table(
  "chat_sessions",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    title: text("title").notNull().default("New chat"),
    model: text("model").$type<AgentModelId>().notNull(),
    engine: text("engine").$type<ChatEngine>().notNull().default("opencompany"),
    kind: text("kind").$type<ChatSessionKind>().notNull().default("chat"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    hasUnseen: boolean("has_unseen").notNull().default(false),
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
export const chatShares = productSchema.table(
  "chat_session_shares",
  {
    id: text("id").primaryKey(),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
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
export const actionTurns = productSchema.table(
  "action_turns",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
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
export const capabilityRuns = productSchema.table(
  "capability_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "restrict" }),
    toolCallId: text("tool_call_id"),
    source: text("source").$type<ManagedCapabilitySource>().notNull(),
    action: text("action").notNull(),
    inputHash: text("input_hash").notNull(),
    provider: text("provider").notNull(),
    endpoint: text("endpoint").notNull(),
    status: text("status").$type<CapabilityRunStatus>().notNull(),
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

export const chatMessages = productSchema.table(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: text("role").$type<ChatRole>().notNull(),
    content: text("content").notNull().default(""),
    taskId: text("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    debugTrace: jsonb("debug_trace").$type<ChatMessageDebugTrace | null>(),
    attachments: jsonb("attachments").$type<ChatMessageAttachment[] | null>(),
    // docx/xlsx/srt/csv/tsv/json/text extracted text keyed by attachment id; server-side model context
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
    attachmentTextsObjectCheck: check(
      "chat_messages_attachment_texts_object_check",
      sql`${table.attachmentTexts} IS NULL OR jsonb_typeof(${table.attachmentTexts}) = 'object'`,
    ),
  }),
);

// One immutable row per Auto classifier attempt. Prompt content is deliberately
// excluded; lengths, outcomes, safe provider metadata, and usage are sufficient
// to diagnose routing reliability without creating a second message store.
export const chatModelRoutingAttempts = productSchema.table(
  "chat_model_routing_attempts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    chatSessionId: text("chat_session_id").references(() => chatSessions.id, {
      onDelete: "set null",
    }),
    userMessageId: text("user_message_id").references(() => chatMessages.id, {
      onDelete: "set null",
    }),
    classifierModel: text("classifier_model").notNull(),
    selectedModel: text("selected_model").$type<AgentModelId>().notNull(),
    tier: text("tier").$type<ChatModelRoutingTier>().notNull(),
    reason: text("reason").$type<ChatModelRoutingReason>().notNull(),
    outcome: text("outcome").$type<ChatModelRoutingOutcome>().notNull(),
    durationMs: integer("duration_ms").notNull(),
    errorCategory: text("error_category").$type<ChatModelRoutingErrorCategory>(),
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

export const chatSandboxUsage = productSchema.table(
  "chat_sandbox_usage",
  {
    id: serial("id").primaryKey(),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    userMessageId: text("user_message_id").references(() => chatMessages.id, {
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

export const browserProfiles = productSchema.table(
  "browser_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    name: text("name").notNull(),
    siteHost: text("site_host").notNull(),
    allowedHosts: jsonb("allowed_hosts").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: text("status").$type<BrowserProfileStatus>().notNull().default("pending_login"),
    encryptedBrowserbaseContextId: jsonb("encrypted_browserbase_context_id")
      .$type<IntegrationCredentialEncryptedPayload>()
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

export const browserProfileSessions = productSchema.table(
  "browser_profile_sessions",
  {
    id: serial("id").primaryKey(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => browserProfiles.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    chatSessionId: text("chat_session_id").references(() => chatSessions.id, {
      onDelete: "set null",
    }),
    userMessageId: text("user_message_id").references(() => chatMessages.id, {
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
export const chatSessionSkills = productSchema.table(
  "chat_session_skills",
  {
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    // Provenance only: the immutable snapshot must survive deletion of its source Brain.
    brainRef: text("brain_ref").notNull(),
    activatedMessageId: text("activated_message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
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

export const codexChatSessions = productSchema.table(
  "codex_chat_sessions",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    engine: text("engine").$type<CodexChatEngine>().notNull().default("codex"),
    model: text("model").notNull().default("gpt-5.5"),
    brainRef: text("brain_ref").references(() => brains.id, {
      onDelete: "set null",
    }),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    hostToolContractVersion: text("host_tool_contract_version"),
    sandboxId: text("sandbox_id"),
    codexThreadId: text("codex_thread_id"),
    activeTurnId: text("active_turn_id"),
    status: text("status").$type<CodexChatSessionStatus>().notNull().default("queued"),
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

export const codexChatTurns = productSchema.table(
  "codex_chat_turns",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    codexChatSessionId: text("codex_chat_session_id")
      .notNull()
      .references(() => codexChatSessions.id, { onDelete: "cascade" }),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    userMessageId: text("user_message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    assistantMessageId: text("assistant_message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    codexTurnId: text("codex_turn_id"),
    status: text("status").$type<CodexChatTurnStatus>().notNull().default("queued"),
    prompt: text("prompt").notNull(),
    settings: jsonb("settings").$type<CodexChatTurnSettings>().notNull().default(sql`'{}'::jsonb`),
    error: text("error"),
    interruptRequestedAt: timestamp("interrupt_requested_at", {
      withTimezone: true,
    }),
    attempts: integer("attempts").notNull().default(0),
    recoveryAttempts: integer("recovery_attempts").notNull().default(0),
    engineRecoveryRequired: boolean("engine_recovery_required").notNull().default(false),
    engineTurnBaselineIds: jsonb("engine_turn_baseline_ids").$type<string[]>(),
    eventSequence: integer("event_sequence").notNull().default(0),
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
      "goat_codex_chat_turns_status_v2_check",
      sql`${table.status} IN ('queued', 'running', 'paused', 'completed', 'failed', 'interrupted')`,
    ),
    eventSequenceCheck: check(
      "goat_codex_chat_turns_event_sequence_check",
      sql`${table.eventSequence} >= 0`,
    ),
  }),
);

// The first canonical headless Chat write path is intentionally backed by the existing durable
// runtime tables. These additive rows provide the protocol concepts that were previously implicit:
// command idempotency, explicit execution attempts, and a semantic event log. Physical legacy
// names stay confined to persistence adapters and never cross the core or wire boundary.
export const chatCommandIdempotency = productSchema.table(
  "chat_command_idempotency",
  {
    commandId: text("command_id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    conversationId: text("conversation_id").notNull(),
    messageId: text("message_id").notNull(),
    assistantMessageId: text("assistant_message_id").notNull(),
    runtimeId: text("runtime_id").notNull(),
    runId: text("run_id").notNull(),
    transactionId: bigint("transaction_id", { mode: "number" })
      .notNull()
      .default(sql`pg_current_xact_id()::xid::text::bigint`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    touchedAt: timestamp("touched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    actorKeyIdx: uniqueIndex("goat_chat_command_idempotency_actor_key_idx").on(
      table.userWorkosId,
      table.workspaceId,
      table.idempotencyKey,
    ),
    requestHashCheck: check(
      "goat_chat_command_idempotency_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    keyLengthCheck: check(
      "goat_chat_command_idempotency_key_length_check",
      sql`length(${table.idempotencyKey}) BETWEEN 1 AND 200`,
    ),
  }),
);

export const taskCommandIdempotency = productSchema.table(
  "task_command_idempotency",
  {
    commandId: text("command_id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    taskId: text("task_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    messageId: text("message_id").notNull(),
    assistantMessageId: text("assistant_message_id").notNull(),
    runtimeId: text("runtime_id").notNull(),
    runId: text("run_id").notNull(),
    transactionId: bigint("transaction_id", { mode: "number" })
      .notNull()
      .default(sql`pg_current_xact_id()::xid::text::bigint`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    touchedAt: timestamp("touched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    actorKeyIdx: uniqueIndex("goat_task_command_idempotency_actor_key_idx").on(
      table.userWorkosId,
      table.workspaceId,
      table.idempotencyKey,
    ),
    requestHashCheck: check(
      "goat_task_command_idempotency_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    keyLengthCheck: check(
      "goat_task_command_idempotency_key_length_check",
      sql`length(${table.idempotencyKey}) BETWEEN 1 AND 200`,
    ),
  }),
);

export const automationCommandIdempotency = productSchema.table(
  "automation_command_idempotency",
  {
    commandId: text("command_id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    operation: text("operation").$type<AutomationCommandOperation>().notNull(),
    resourceId: text("resource_id").notNull(),
    transactionId: bigint("transaction_id", { mode: "number" })
      .notNull()
      .default(sql`pg_current_xact_id()::xid::text::bigint`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    touchedAt: timestamp("touched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    actorKeyIdx: uniqueIndex("goat_automation_command_idempotency_actor_key_idx").on(
      table.userWorkosId,
      table.workspaceId,
      table.idempotencyKey,
    ),
    requestHashCheck: check(
      "goat_automation_command_idempotency_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    keyLengthCheck: check(
      "goat_automation_command_idempotency_key_length_check",
      sql`length(${table.idempotencyKey}) BETWEEN 1 AND 200`,
    ),
    operationCheck: check(
      "goat_automation_command_idempotency_operation_check",
      sql`${table.operation} IN ('workflow.create', 'task_schedule.create')`,
    ),
  }),
);

export const knowledgeCommandIdempotency = productSchema.table(
  "knowledge_command_idempotency",
  {
    commandId: text("command_id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    operation: text("operation").$type<KnowledgeCommandOperation>().notNull(),
    resourceId: text("resource_id").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    initialStateHash: text("initial_state_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    touchedAt: timestamp("touched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    actorKeyIdx: uniqueIndex("goat_knowledge_command_idempotency_actor_key_idx").on(
      table.userWorkosId,
      table.workspaceId,
      table.idempotencyKey,
    ),
    requestHashCheck: check(
      "goat_knowledge_command_idempotency_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    keyLengthCheck: check(
      "goat_knowledge_command_idempotency_key_length_check",
      sql`length(${table.idempotencyKey}) BETWEEN 1 AND 200`,
    ),
    operationCheck: check(
      "goat_knowledge_command_idempotency_operation_check",
      sql`${table.operation} IN ('brain_document.create', 'brain_asset.create', 'brain_asset.replace', 'wiki_page.create', 'wiki_timeline.create', 'skill.create', 'skill.import')`,
    ),
  }),
);

// Billing commands cross an external Stripe boundary, so their client key,
// request fingerprint, and narrow response are durable. An incomplete row is
// safe to retry: Stripe receives a deterministic idempotency key and local
// mutations are themselves idempotent.
export const billingCommandIdempotency = productSchema.table(
  "billing_command_idempotency",
  {
    commandId: text("command_id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    operation: text("operation").$type<BillingCommandOperation>().notNull(),
    response: jsonb("response").$type<Record<string, unknown>>(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    touchedAt: timestamp("touched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    actorKeyIdx: uniqueIndex("goat_billing_command_idempotency_actor_key_idx").on(
      table.userWorkosId,
      table.workspaceId,
      table.idempotencyKey,
    ),
    requestHashCheck: check(
      "goat_billing_command_idempotency_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    keyLengthCheck: check(
      "goat_billing_command_idempotency_key_length_check",
      sql`length(${table.idempotencyKey}) BETWEEN 1 AND 200`,
    ),
    operationCheck: check(
      "goat_billing_command_idempotency_operation_check",
      sql`${table.operation} IN ('credit_topup.create', 'subscription_checkout.create', 'billing_portal.create', 'auto_refill.update')`,
    ),
  }),
);

export const runAttempts = productSchema.table(
  "run_attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => codexChatTurns.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    status: text("status").$type<RunAttemptStatus>().notNull(),
    workerId: text("worker_id").notNull(),
    deployVersion: text("deploy_version"),
    leaseId: text("lease_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runNumberIdx: uniqueIndex("goat_run_attempts_run_number_idx").on(table.runId, table.number),
    leaseIdx: uniqueIndex("goat_run_attempts_lease_idx")
      .on(table.leaseId)
      .where(sql`${table.leaseId} IS NOT NULL`),
    statusCheck: check(
      "goat_run_attempts_status_check",
      sql`${table.status} IN (${sql.join(
        RUN_ATTEMPT_STATUSES.map((status) => sql`${status}`),
        sql`, `,
      )})`,
    ),
    numberCheck: check("goat_run_attempts_number_check", sql`${table.number} > 0`),
  }),
);

export const runApprovals = productSchema.table(
  "run_approvals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => codexChatTurns.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id").references(() => runAttempts.id, {
      onDelete: "set null",
    }),
    toolCallId: text("tool_call_id"),
    kind: text("kind").notNull(),
    prompt: text("prompt").notNull(),
    options: jsonb("options").$type<string[]>(),
    status: text("status").$type<RunApprovalStatus>().notNull().default("pending"),
    resolution: text("resolution").$type<ApprovalResolution>(),
    response: jsonb("response").$type<Record<string, unknown>>(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runStatusCreatedIdx: index("goat_run_approvals_run_status_created_idx").on(
      table.runId,
      table.status,
      table.createdAt,
    ),
    attemptIdx: index("goat_run_approvals_attempt_idx").on(table.attemptId),
    statusCheck: check(
      "goat_run_approvals_status_check",
      sql`${table.status} IN (${sql.join(
        RUN_APPROVAL_STATUSES.map((status) => sql`${status}`),
        sql`, `,
      )})`,
    ),
    resolutionCheck: check(
      "goat_run_approvals_resolution_check",
      sql`${table.resolution} IS NULL OR ${table.resolution} IN (${sql.join(
        APPROVAL_RESOLUTIONS.map((resolution) => sql`${resolution}`),
        sql`, `,
      )})`,
    ),
    lifecycleCheck: check(
      "goat_run_approvals_lifecycle_check",
      sql`(
        ${table.status} = 'pending'
        AND ${table.resolution} IS NULL
        AND ${table.resolvedAt} IS NULL
      ) OR (
        ${table.status} IN ('resolved', 'canceled')
        AND ${table.resolution} IS NOT NULL
        AND ${table.resolvedAt} IS NOT NULL
      )`,
    ),
  }),
);

export const runEvents = productSchema.table(
  "run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => codexChatTurns.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id").references(() => runAttempts.id, {
      onDelete: "set null",
    }),
    sequence: integer("sequence").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    type: text("type").$type<RunEventType>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runSequenceIdx: uniqueIndex("goat_run_events_run_sequence_idx").on(table.runId, table.sequence),
    attemptIdx: index("goat_run_events_attempt_idx").on(table.attemptId),
    typeCheck: check(
      "goat_run_events_type_check",
      sql`${table.type} IN (${sql.join(
        RUN_EVENT_TYPES.map((eventType) => sql`${eventType}`),
        sql`, `,
      )})`,
    ),
    sequenceCheck: check("goat_run_events_sequence_check", sql`${table.sequence} > 0`),
    schemaVersionCheck: check(
      "goat_run_events_schema_version_check",
      sql`${table.schemaVersion} = 1`,
    ),
  }),
);

// Electric projects these additive tables through fixed /v1 read-model names. Actor/workspace
// scope is retained for server authorization but omitted from the client-visible column sets.
export const conversationReadModelV1 = productSchema.table(
  "conversation_read_model_v1",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id").notNull(),
    workspaceId: text("workspace_id"),
    title: text("title").notNull(),
    engine: text("engine").$type<ChatEngine>().notNull(),
    model: text("model").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    activityState: text("activity_state").$type<ChatActivityState>().notNull().default("idle"),
    hasUnseen: boolean("has_unseen").notNull().default(false),
    runtimeStatus: text("runtime_status").$type<ConversationRuntimeStatus>(),
    activeRunId: text("active_run_id"),
    runtimeHasError: boolean("runtime_has_error"),
    runtimeUpdatedAt: timestamp("runtime_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    actorWorkspaceUpdatedIdx: index(
      "goat_conversation_read_model_v1_actor_workspace_updated_idx",
    ).on(table.actorId, table.workspaceId, table.updatedAt),
    activityStateCheck: check(
      "goat_conversation_read_model_v1_activity_state_check",
      sql`${table.activityState} IN ('working', 'idle')`,
    ),
    runtimeStatusCheck: check(
      "conversation_read_model_v1_runtime_status_check",
      sql`${table.runtimeStatus} IS NULL OR ${table.runtimeStatus} IN ('queued', 'starting', 'idle', 'running', 'failed', 'interrupted', 'closed')`,
    ),
    runtimeSummaryCheck: check(
      "conversation_read_model_v1_runtime_summary_check",
      sql`(
        ${table.runtimeStatus} IS NULL
        AND ${table.activeRunId} IS NULL
        AND ${table.runtimeHasError} IS NULL
        AND ${table.runtimeUpdatedAt} IS NULL
      ) OR (
        ${table.runtimeStatus} IS NOT NULL
        AND ${table.runtimeHasError} IS NOT NULL
        AND ${table.runtimeUpdatedAt} IS NOT NULL
      )`,
    ),
  }),
);

export const messageReadModelV1 = productSchema.table(
  "message_read_model_v1",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    actorId: text("actor_id").notNull(),
    workspaceId: text("workspace_id"),
    role: text("role").$type<ChatMessage["role"]>().notNull(),
    content: text("content").notNull(),
    taskId: text("task_id"),
    presentation: jsonb("presentation").$type<ChatMessageDebugTrace>(),
    attachments: jsonb("attachments").$type<ChatMessageAttachment[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    actorWorkspaceConversationIdx: index(
      "goat_message_read_model_v1_actor_workspace_conversation_idx",
    ).on(table.actorId, table.workspaceId, table.conversationId, table.createdAt),
  }),
);

export const runReadModelV1 = productSchema.table(
  "run_read_model_v1",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    actorId: text("actor_id").notNull(),
    workspaceId: text("workspace_id"),
    triggerMessageId: text("trigger_message_id").notNull(),
    assistantMessageId: text("assistant_message_id").notNull(),
    status: text("status").$type<RunStatus>().notNull(),
    engine: text("engine").$type<ChatEngine>().notNull(),
    model: text("model").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    actorWorkspaceConversationIdx: index(
      "goat_run_read_model_v1_actor_workspace_conversation_idx",
    ).on(table.actorId, table.workspaceId, table.conversationId, table.createdAt),
  }),
);

export const taskReadModelV1 = productSchema.table(
  "task_read_model_v1",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id").notNull(),
    workspaceId: text("workspace_id"),
    displayId: text("display_id").notNull(),
    name: text("name").notNull(),
    goal: text("goal").notNull(),
    conversationId: text("conversation_id").notNull(),
    status: text("status").$type<TaskStatus>().notNull(),
    source: text("source").$type<TaskSource>().notNull(),
    engine: text("engine").$type<ChatEngine>().notNull(),
    model: text("model").notNull(),
    workflowId: text("workflow_id"),
    scheduleId: text("schedule_id"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    result: text("result"),
    error: text("error"),
    reportedStatus: text("reported_status").$type<TaskReportedOutcome>(),
    outcomeComment: text("outcome_comment"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    workspaceArchivedUpdatedIdx: index("goat_task_read_model_v1_workspace_archived_updated_idx").on(
      table.workspaceId,
      table.archivedAt,
      table.updatedAt,
    ),
    actorArchivedUpdatedIdx: index("goat_task_read_model_v1_actor_archived_updated_idx").on(
      table.actorId,
      table.archivedAt,
      table.updatedAt,
    ),
    conversationIdx: uniqueIndex("goat_task_read_model_v1_conversation_idx").on(
      table.conversationId,
    ),
  }),
);

export const workflowReadModelV1 = productSchema.table(
  "workflow_read_model_v1",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    steps: jsonb("steps").$type<WorkflowStep[]>().notNull(),
    status: text("status").$type<WorkflowStatus>().notNull(),
    trigger: jsonb("trigger").$type<Record<string, unknown>>().notNull(),
    scheduleCron: text("schedule_cron"),
    scheduleTimezone: text("schedule_timezone").notNull(),
    schedulePrompt: text("schedule_prompt").notNull(),
    scheduleEnabled: boolean("schedule_enabled").notNull(),
    scheduleLastRunAt: timestamp("schedule_last_run_at", { withTimezone: true }),
    scheduleNextRunAt: timestamp("schedule_next_run_at", { withTimezone: true }),
    version: integer("version").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    workspaceUpdatedIdx: index("goat_workflow_read_model_v1_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt,
    ),
    workspaceSlugIdx: uniqueIndex("goat_workflow_read_model_v1_workspace_slug_idx").on(
      table.workspaceId,
      table.slug,
    ),
  }),
);

export const workflowScheduleReadModelV1 = productSchema.table(
  "workflow_schedule_read_model_v1",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    workflowSlug: text("workflow_slug").notNull(),
    name: text("name").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull(),
    prompt: text("prompt").notNull(),
    enabled: boolean("enabled").notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    version: integer("version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    workspaceUpdatedIdx: index("goat_workflow_schedule_read_model_v1_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt,
    ),
    workspaceSlugIdx: uniqueIndex("goat_workflow_schedule_read_model_v1_workspace_slug_idx").on(
      table.workspaceId,
      table.workflowSlug,
    ),
  }),
);

export const taskScheduleReadModelV1 = productSchema.table(
  "task_schedule_read_model_v1",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id").notNull(),
    workspaceId: text("workspace_id"),
    name: text("name").notNull(),
    sourceDescription: text("source_description").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull(),
    prompt: text("prompt").notNull(),
    enabled: boolean("enabled").notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    version: integer("version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    actorWorkspaceUpdatedIdx: index(
      "goat_task_schedule_read_model_v1_actor_workspace_updated_idx",
    ).on(table.actorId, table.workspaceId, table.updatedAt),
  }),
);

// Uploads are actor/workspace scoped before a Message can reference them. Private blob locators
// and extracted text remain persistence details; the protocol carries only the opaque id and
// public metadata. claimed_message_id is deliberately retained as an immutable audit reference
// rather than an FK so normal conversation deletion cannot make an upload reusable.
export const chatAttachmentUploads = productSchema.table(
  "chat_attachment_uploads",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    format: text("format").$type<ChatAttachmentFormat>().notNull(),
    mediaType: text("media_type").notNull(),
    filename: text("filename").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    blobPathname: text("blob_pathname").notNull(),
    blobUrl: text("blob_url").notNull(),
    extractedText: text("extracted_text"),
    claimedMessageId: text("claimed_message_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    actorUnclaimedIdx: index("goat_chat_attachment_uploads_actor_unclaimed_idx")
      .on(table.userWorkosId, table.workspaceId, table.expiresAt)
      .where(sql`${table.claimedAt} IS NULL`),
    claimedMessageIdx: index("goat_chat_attachment_uploads_claimed_message_idx").on(
      table.claimedMessageId,
    ),
    blobPathnameIdx: uniqueIndex("goat_chat_attachment_uploads_blob_pathname_idx").on(
      table.blobPathname,
    ),
    formatCheck: check(
      "goat_chat_attachment_uploads_format_check",
      sql`${table.format} IN (${sql.join(
        CHAT_ATTACHMENT_FORMATS.map((format) => sql`${format}`),
        sql`, `,
      )})`,
    ),
    sizeCheck: check(
      "goat_chat_attachment_uploads_size_check",
      sql`${table.sizeBytes} > 0 AND ${table.sizeBytes} <= 20971520`,
    ),
    lifecycleCheck: check(
      "goat_chat_attachment_uploads_lifecycle_check",
      sql`(${table.claimedAt} IS NULL AND ${table.claimedMessageId} IS NULL)
        OR (${table.claimedAt} IS NOT NULL AND ${table.claimedMessageId} IS NOT NULL)`,
    ),
    expiryCheck: check(
      "goat_chat_attachment_uploads_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  }),
);

// A user-visible file published from a cloud coding chat. The logical artifact has a
// stable identity while every publication creates an immutable version below. V1 keeps
// artifacts scoped to their originating workspace, owner, and chat; later surfaces can
// reuse the same version model without exposing sandbox paths or private blob locators.
export const chatArtifacts = productSchema.table(
  "chat_artifacts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    currentVersion: integer("current_version").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceUpdatedIdx: index("goat_chat_artifacts_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt,
    ),
    ownerChatCreatedIdx: index("goat_chat_artifacts_owner_chat_created_idx").on(
      table.userWorkosId,
      table.chatSessionId,
      table.createdAt,
    ),
    currentVersionCheck: check(
      "goat_chat_artifacts_current_version_check",
      sql`${table.currentVersion} >= 0`,
    ),
  }),
);

export const chatArtifactVersions = productSchema.table(
  "chat_artifact_versions",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => chatArtifacts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    filename: text("filename").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    contentSha256: text("content_sha256").notNull(),
    blobPathname: text("blob_pathname").notNull(),
    sourceEngine: text("source_engine").$type<CodexChatEngine>().notNull(),
    sourceToolCallId: text("source_tool_call_id").notNull(),
    sourceTurnId: text("source_turn_id").references(() => codexChatTurns.id, {
      onDelete: "set null",
    }),
    sourceMessageId: text("source_message_id").references(() => chatMessages.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    artifactVersionIdx: uniqueIndex("goat_chat_artifact_versions_artifact_version_idx").on(
      table.artifactId,
      table.version,
    ),
    sourceTurnCreatedIdx: index("goat_chat_artifact_versions_source_turn_created_idx").on(
      table.sourceTurnId,
      table.createdAt,
    ),
    sourceTurnToolCallIdx: uniqueIndex("goat_chat_artifact_versions_source_turn_tool_call_idx").on(
      table.sourceTurnId,
      table.sourceToolCallId,
    ),
    sourceMessageIdx: index("goat_chat_artifact_versions_source_message_idx").on(
      table.sourceMessageId,
    ),
    versionSizeCheck: check(
      "goat_chat_artifact_versions_version_size_check",
      sql`${table.version} > 0 AND ${table.sizeBytes} >= 0 AND ${table.sizeBytes} <= 20971520`,
    ),
    contentSha256Check: check(
      "goat_chat_artifact_versions_content_sha256_check",
      sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    sourceEngineCheck: check(
      "goat_chat_artifact_versions_source_engine_check",
      sql`${table.sourceEngine} IN ('codex', 'claude_code')`,
    ),
  }),
);

export const codexChatInteractions = productSchema.table(
  "codex_chat_interactions",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    codexChatSessionId: text("codex_chat_session_id")
      .notNull()
      .references(() => codexChatSessions.id, { onDelete: "cascade" }),
    codexChatTurnId: text("codex_chat_turn_id")
      .notNull()
      .references(() => codexChatTurns.id, { onDelete: "cascade" }),
    leaseId: text("lease_id").notNull(),
    requestId: text("request_id").notNull(),
    itemId: text("item_id"),
    method: text("method").notNull(),
    status: text("status").$type<CodexChatInteractionStatus>().notNull().default("pending"),
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

export const codexChatEvents = productSchema.table(
  "codex_chat_events",
  {
    id: serial("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    codexChatSessionId: text("codex_chat_session_id")
      .notNull()
      .references(() => codexChatSessions.id, { onDelete: "cascade" }),
    codexChatTurnId: text("codex_chat_turn_id").references(() => codexChatTurns.id, {
      onDelete: "set null",
    }),
    eventKey: text("event_key"),
    type: text("type").$type<CodexChatEventType>().notNull(),
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
        CODEX_CHAT_EVENT_TYPES.map((eventType) => sql`${eventType}`),
        sql`, `,
      )})`,
    ),
  }),
);

export const brainToolRuns = productSchema.table(
  "brain_tool_runs",
  {
    id: text("id").primaryKey(),
    brainRef: text("brain_ref").references(() => brains.id, {
      onDelete: "set null",
    }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    chatSessionId: text("chat_session_id").references(() => chatSessions.id, {
      onDelete: "set null",
    }),
    userMessageId: text("user_message_id").references(() => chatMessages.id, {
      onDelete: "set null",
    }),
    assistantMessageId: text("assistant_message_id").references(() => chatMessages.id, {
      onDelete: "set null",
    }),
    toolCallId: text("tool_call_id"),
    sourceRef: text("source_ref"),
    action: text("action"),
    ok: boolean("ok").notNull().default(false),
    exitCode: integer("exit_code"),
    durationMs: integer("duration_ms"),
    tracePath: text("trace_path"),
    trace: jsonb("trace").$type<BrainToolRunTrace>().notNull().default(sql`'{}'::jsonb`),
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

export const codexCredentials = productSchema.table(
  "codex_credentials",
  {
    userWorkosId: text("user_workos_id")
      .primaryKey()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    encryptedAuthJson: jsonb("encrypted_auth_json")
      .$type<IntegrationCredentialEncryptedPayload>()
      .notNull(),
    encryptionKeyVersion: integer("encryption_key_version").notNull(),
    status: text("status").$type<CodexCredentialStatus>().notNull().default("connected"),
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

export const codexDeviceAuthFlows = productSchema.table(
  "codex_device_auth_flows",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    sandboxId: text("sandbox_id").notNull(),
    userCode: text("user_code"),
    verificationUri: text("verification_uri"),
    status: text("status").$type<CodexDeviceAuthFlowStatus>().notNull().default("pending"),
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

// One human Infisical CLI login shared by every coding sandbox in a workspace. The encrypted
// bundle contains only Infisical's file-vault config and keyring files; project selection remains
// repository-local through .infisical.json. A disconnected tombstone is retained so resumed
// sandboxes can observe the new credential generation and remove stale local auth.
export const infisicalConnections = productSchema.table(
  "infisical_connections",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    encryptedAuthBundle:
      jsonb("encrypted_auth_bundle").$type<IntegrationCredentialEncryptedPayload>(),
    encryptionKeyVersion: integer("encryption_key_version"),
    credentialGeneration: uuid("credential_generation").notNull().defaultRandom(),
    status: text("status").$type<InfisicalConnectionStatus>().notNull().default("disconnected"),
    statusReason: text("status_reason"),
    host: text("host").notNull().default("https://app.infisical.com"),
    accountEmail: text("account_email"),
    cliVersion: text("cli_version"),
    bundleFormatVersion: integer("bundle_format_version"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    connectedByWorkosId: text("connected_by_workos_id").references(() => users.workosUserId, {
      onDelete: "set null",
    }),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("goat_infisical_connections_status_idx").on(table.status),
    connectedByIdx: index("goat_infisical_connections_connected_by_idx").on(
      table.connectedByWorkosId,
    ),
    statusCheck: check(
      "goat_infisical_connections_status_check",
      sql`${table.status} IN ('connected', 'needs_reauth', 'disconnected')`,
    ),
    credentialCheck: check(
      "goat_infisical_connections_credential_check",
      sql`(${table.status} = 'disconnected' AND ${table.encryptedAuthBundle} IS NULL AND ${table.encryptionKeyVersion} IS NULL) OR (${table.status} IN ('connected', 'needs_reauth') AND ${table.encryptedAuthBundle} IS NOT NULL AND ${table.encryptionKeyVersion} IS NOT NULL)`,
    ),
  }),
);

export const infisicalAuthFlows = productSchema.table(
  "infisical_auth_flows",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requestedByWorkosId: text("requested_by_workos_id").references(() => users.workosUserId, {
      onDelete: "set null",
    }),
    sandboxId: text("sandbox_id").notNull(),
    loginUrl: text("login_url"),
    status: text("status").$type<InfisicalAuthFlowStatus>().notNull().default("pending"),
    statusReason: text("status_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceStatusIdx: index("goat_infisical_auth_flows_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
    expiresAtIdx: index("goat_infisical_auth_flows_expires_at_idx").on(table.expiresAt),
    statusCheck: check(
      "goat_infisical_auth_flows_status_check",
      sql`${table.status} IN ('pending', 'link_ready', 'completed', 'failed', 'expired')`,
    ),
  }),
);

// Claude Code subscription auth: one long-lived setup-token per user, pasted in
// settings (no device flow exists for Claude Code). Strictly per-user — sharing a
// subscription credential across users is prohibited by Anthropic's terms.
export const claudeCodeCredentials = productSchema.table(
  "claude_code_credentials",
  {
    userWorkosId: text("user_workos_id")
      .primaryKey()
      .references(() => users.workosUserId, { onDelete: "cascade" }),
    encryptedAuthJson: jsonb("encrypted_auth_json")
      .$type<IntegrationCredentialEncryptedPayload>()
      .notNull(),
    encryptionKeyVersion: integer("encryption_key_version").notNull(),
    status: text("status").$type<CodexCredentialStatus>().notNull().default("connected"),
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

export const usersRelations = relations(users, ({ many }) => ({
  workspaceMemberships: many(workspaceMembers),
  brainMemberships: many(brainMembers),
  brainFolders: many(brainFolders),
  brainDocuments: many(brainDocuments),
  brainTimelineEntries: many(brainTimelineEntries),
  brainEdges: many(brainEdges),
  brainDocumentVersions: many(brainDocumentVersions),
  brainToolRuns: many(brainToolRuns),
  taskSchedules: many(taskSchedules),
  taskScheduleRuns: many(taskScheduleRuns),
  tasks: many(tasks),
  taskMessages: many(taskMessages),
  taskEvents: many(taskEvents),
  taskModelUsage: many(taskModelUsage),
  taskToolUsage: many(taskToolUsage),
  taskSandboxUsage: many(taskSandboxUsage),
  chatSessions: many(chatSessions),
  chatSandboxUsage: many(chatSandboxUsage),
  browserProfiles: many(browserProfiles),
  browserProfileSessions: many(browserProfileSessions),
  capabilityRuns: many(capabilityRuns),
  capabilityOverrides: many(workspaceCapabilities),
  integrations: many(integrations),
  integrationCredentials: many(integrationCredentials),
  integrationResources: many(integrationResources),
  repoConfigs: many(repoConfigs),
  brainSourceItems: many(brainSourceItems),
  brainIngestJobs: many(brainIngestJobs),
  codexDeviceAuthFlows: many(codexDeviceAuthFlows),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  createdBy: one(users, {
    fields: [workspaces.createdByWorkosId],
    references: [users.workosUserId],
  }),
  members: many(workspaceMembers),
  capabilities: many(workspaceCapabilities),
  capabilityRuns: many(capabilityRuns),
  billing: one(workspaceBilling),
  ingestionReservations: many(workspaceIngestionReservations),
  brains: many(brains),
  repoConfigs: many(repoConfigs),
}));

export const workspaceBillingRelations = relations(workspaceBilling, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceBilling.workspaceId],
    references: [workspaces.id],
  }),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMembers.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [workspaceMembers.userWorkosId],
    references: [users.workosUserId],
  }),
}));

export const workspaceCapabilitiesRelations = relations(workspaceCapabilities, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceCapabilities.workspaceId],
    references: [workspaces.id],
  }),
  updatedBy: one(users, {
    fields: [workspaceCapabilities.updatedByWorkosId],
    references: [users.workosUserId],
  }),
}));

export const brainsRelations = relations(brains, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [brains.workspaceId],
    references: [workspaces.id],
  }),
  createdBy: one(users, {
    fields: [brains.createdByWorkosId],
    references: [users.workosUserId],
  }),
  members: many(brainMembers),
  documents: many(brainDocuments),
  folders: many(brainFolders),
}));

export const brainMembersRelations = relations(brainMembers, ({ one }) => ({
  brain: one(brains, {
    fields: [brainMembers.brainId],
    references: [brains.id],
  }),
  user: one(users, {
    fields: [brainMembers.userWorkosId],
    references: [users.workosUserId],
  }),
}));

export const brainFoldersRelations = relations(brainFolders, ({ one }) => ({
  user: one(users, {
    fields: [brainFolders.userWorkosId],
    references: [users.workosUserId],
  }),
  brain: one(brains, {
    fields: [brainFolders.brainRef],
    references: [brains.id],
  }),
}));

export const brainDocumentsRelations = relations(brainDocuments, ({ one, many }) => ({
  user: one(users, {
    fields: [brainDocuments.userWorkosId],
    references: [users.workosUserId],
  }),
  brain: one(brains, {
    fields: [brainDocuments.brainRef],
    references: [brains.id],
  }),
  timelineEntries: many(brainTimelineEntries),
  edges: many(brainEdges),
  versions: many(brainDocumentVersions),
}));

export const brainTimelineEntriesRelations = relations(brainTimelineEntries, ({ one }) => ({
  user: one(users, {
    fields: [brainTimelineEntries.userWorkosId],
    references: [users.workosUserId],
  }),
  document: one(brainDocuments, {
    fields: [brainTimelineEntries.documentId],
    references: [brainDocuments.id],
  }),
}));

export const brainEdgesRelations = relations(brainEdges, ({ one }) => ({
  user: one(users, {
    fields: [brainEdges.userWorkosId],
    references: [users.workosUserId],
  }),
  document: one(brainDocuments, {
    fields: [brainEdges.documentId],
    references: [brainDocuments.id],
  }),
}));

export const brainDocumentVersionsRelations = relations(brainDocumentVersions, ({ one }) => ({
  user: one(users, {
    fields: [brainDocumentVersions.userWorkosId],
    references: [users.workosUserId],
  }),
  document: one(brainDocuments, {
    fields: [brainDocumentVersions.documentId],
    references: [brainDocuments.id],
  }),
}));

export const wikiPagesRelations = relations(wikiPages, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [wikiPages.workspaceId],
    references: [workspaces.id],
  }),
  versions: many(wikiPageVersions),
  timelineEntries: many(wikiTimelineEntries),
  links: many(wikiLinks),
}));

export const wikiPageVersionsRelations = relations(wikiPageVersions, ({ one }) => ({
  page: one(wikiPages, {
    fields: [wikiPageVersions.pageId],
    references: [wikiPages.id],
  }),
}));

export const wikiTimelineEntriesRelations = relations(wikiTimelineEntries, ({ one }) => ({
  page: one(wikiPages, {
    fields: [wikiTimelineEntries.pageId],
    references: [wikiPages.id],
  }),
}));

export const wikiLinksRelations = relations(wikiLinks, ({ one }) => ({
  fromPage: one(wikiPages, {
    fields: [wikiLinks.fromPageId],
    references: [wikiPages.id],
  }),
}));

export const brainToolRunsRelations = relations(brainToolRuns, ({ one }) => ({
  user: one(users, {
    fields: [brainToolRuns.userWorkosId],
    references: [users.workosUserId],
  }),
  chatSession: one(chatSessions, {
    fields: [brainToolRuns.chatSessionId],
    references: [chatSessions.id],
  }),
  userMessage: one(chatMessages, {
    fields: [brainToolRuns.userMessageId],
    references: [chatMessages.id],
    relationName: "goat_brain_tool_runs_user_message",
  }),
  assistantMessage: one(chatMessages, {
    fields: [brainToolRuns.assistantMessageId],
    references: [chatMessages.id],
    relationName: "goat_brain_tool_runs_assistant_message",
  }),
}));

export const codexChatSessionsRelations = relations(codexChatSessions, ({ one, many }) => ({
  user: one(users, {
    fields: [codexChatSessions.userWorkosId],
    references: [users.workosUserId],
  }),
  chatSession: one(chatSessions, {
    fields: [codexChatSessions.chatSessionId],
    references: [chatSessions.id],
  }),
  turns: many(codexChatTurns),
  interactions: many(codexChatInteractions),
  events: many(codexChatEvents),
}));

export const codexChatTurnsRelations = relations(codexChatTurns, ({ one, many }) => ({
  user: one(users, {
    fields: [codexChatTurns.userWorkosId],
    references: [users.workosUserId],
  }),
  codexChatSession: one(codexChatSessions, {
    fields: [codexChatTurns.codexChatSessionId],
    references: [codexChatSessions.id],
  }),
  chatSession: one(chatSessions, {
    fields: [codexChatTurns.chatSessionId],
    references: [chatSessions.id],
  }),
  userMessage: one(chatMessages, {
    fields: [codexChatTurns.userMessageId],
    references: [chatMessages.id],
    relationName: "goat_codex_chat_turns_user_message",
  }),
  assistantMessage: one(chatMessages, {
    fields: [codexChatTurns.assistantMessageId],
    references: [chatMessages.id],
    relationName: "goat_codex_chat_turns_assistant_message",
  }),
  interactions: many(codexChatInteractions),
  events: many(codexChatEvents),
  artifactVersions: many(chatArtifactVersions),
  attempts: many(runAttempts),
  approvals: many(runApprovals),
  runEvents: many(runEvents),
}));

export const runAttemptsRelations = relations(runAttempts, ({ one, many }) => ({
  run: one(codexChatTurns, {
    fields: [runAttempts.runId],
    references: [codexChatTurns.id],
  }),
  events: many(runEvents),
  approvals: many(runApprovals),
}));

export const runApprovalsRelations = relations(runApprovals, ({ one }) => ({
  run: one(codexChatTurns, {
    fields: [runApprovals.runId],
    references: [codexChatTurns.id],
  }),
  attempt: one(runAttempts, {
    fields: [runApprovals.attemptId],
    references: [runAttempts.id],
  }),
}));

export const runEventsRelations = relations(runEvents, ({ one }) => ({
  run: one(codexChatTurns, {
    fields: [runEvents.runId],
    references: [codexChatTurns.id],
  }),
  attempt: one(runAttempts, {
    fields: [runEvents.attemptId],
    references: [runAttempts.id],
  }),
}));

export const chatArtifactsRelations = relations(chatArtifacts, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [chatArtifacts.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [chatArtifacts.userWorkosId],
    references: [users.workosUserId],
  }),
  chatSession: one(chatSessions, {
    fields: [chatArtifacts.chatSessionId],
    references: [chatSessions.id],
  }),
  versions: many(chatArtifactVersions),
}));

export const chatArtifactVersionsRelations = relations(chatArtifactVersions, ({ one }) => ({
  artifact: one(chatArtifacts, {
    fields: [chatArtifactVersions.artifactId],
    references: [chatArtifacts.id],
  }),
  sourceTurn: one(codexChatTurns, {
    fields: [chatArtifactVersions.sourceTurnId],
    references: [codexChatTurns.id],
  }),
  sourceMessage: one(chatMessages, {
    fields: [chatArtifactVersions.sourceMessageId],
    references: [chatMessages.id],
  }),
}));

export const codexChatInteractionsRelations = relations(codexChatInteractions, ({ one }) => ({
  user: one(users, {
    fields: [codexChatInteractions.userWorkosId],
    references: [users.workosUserId],
  }),
  codexChatSession: one(codexChatSessions, {
    fields: [codexChatInteractions.codexChatSessionId],
    references: [codexChatSessions.id],
  }),
  codexChatTurn: one(codexChatTurns, {
    fields: [codexChatInteractions.codexChatTurnId],
    references: [codexChatTurns.id],
  }),
}));

export const codexChatEventsRelations = relations(codexChatEvents, ({ one }) => ({
  user: one(users, {
    fields: [codexChatEvents.userWorkosId],
    references: [users.workosUserId],
  }),
  codexChatSession: one(codexChatSessions, {
    fields: [codexChatEvents.codexChatSessionId],
    references: [codexChatSessions.id],
  }),
  codexChatTurn: one(codexChatTurns, {
    fields: [codexChatEvents.codexChatTurnId],
    references: [codexChatTurns.id],
  }),
}));

export const codexCredentialsRelations = relations(codexCredentials, ({ one }) => ({
  user: one(users, {
    fields: [codexCredentials.userWorkosId],
    references: [users.workosUserId],
  }),
}));

export const codexDeviceAuthFlowsRelations = relations(codexDeviceAuthFlows, ({ one }) => ({
  user: one(users, {
    fields: [codexDeviceAuthFlows.userWorkosId],
    references: [users.workosUserId],
  }),
}));

export const claudeCodeCredentialsRelations = relations(claudeCodeCredentials, ({ one }) => ({
  user: one(users, {
    fields: [claudeCodeCredentials.userWorkosId],
    references: [users.workosUserId],
  }),
}));

export const integrationsRelations = relations(integrations, ({ one, many }) => ({
  user: one(users, {
    fields: [integrations.userWorkosId],
    references: [users.workosUserId],
  }),
  credentials: many(integrationCredentials),
  resources: many(integrationResources),
  brainSourceItems: many(brainSourceItems),
}));

export const integrationCredentialsRelations = relations(integrationCredentials, ({ one }) => ({
  user: one(users, {
    fields: [integrationCredentials.userWorkosId],
    references: [users.workosUserId],
  }),
  integration: one(integrations, {
    fields: [integrationCredentials.integrationId],
    references: [integrations.id],
  }),
}));

export const integrationResourcesRelations = relations(integrationResources, ({ one }) => ({
  user: one(users, {
    fields: [integrationResources.userWorkosId],
    references: [users.workosUserId],
  }),
  integration: one(integrations, {
    fields: [integrationResources.integrationId],
    references: [integrations.id],
  }),
}));

export const repoConfigsRelations = relations(repoConfigs, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [repoConfigs.workspaceId],
    references: [workspaces.id],
  }),
  createdBy: one(users, {
    fields: [repoConfigs.createdByWorkosId],
    references: [users.workosUserId],
  }),
}));

export const brainSourceItemsRelations = relations(brainSourceItems, ({ one, many }) => ({
  user: one(users, {
    fields: [brainSourceItems.userWorkosId],
    references: [users.workosUserId],
  }),
  integration: one(integrations, {
    fields: [brainSourceItems.integrationId],
    references: [integrations.id],
  }),
  ingestJobs: many(brainIngestJobs),
  workspaceReservations: many(workspaceIngestionReservations),
}));

export const workspaceIngestionReservationsRelations = relations(
  workspaceIngestionReservations,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [workspaceIngestionReservations.workspaceId],
      references: [workspaces.id],
    }),
    sourceItem: one(brainSourceItems, {
      fields: [workspaceIngestionReservations.sourceItemId],
      references: [brainSourceItems.id],
    }),
  }),
);

export const brainIngestJobsRelations = relations(brainIngestJobs, ({ one }) => ({
  user: one(users, {
    fields: [brainIngestJobs.userWorkosId],
    references: [users.workosUserId],
  }),
  sourceItem: one(brainSourceItems, {
    fields: [brainIngestJobs.sourceItemId],
    references: [brainSourceItems.id],
  }),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  user: one(users, {
    fields: [tasks.userWorkosId],
    references: [users.workosUserId],
  }),
  workspace: one(workspaces, {
    fields: [tasks.workspaceId],
    references: [workspaces.id],
  }),
  session: one(chatSessions, {
    fields: [tasks.sessionId],
    references: [chatSessions.id],
  }),
  schedule: one(taskSchedules, {
    fields: [tasks.scheduleId],
    references: [taskSchedules.id],
  }),
  taskMessages: many(taskMessages),
  taskEvents: many(taskEvents),
  modelUsage: many(taskModelUsage),
  toolUsage: many(taskToolUsage),
  sandboxUsage: many(taskSandboxUsage),
  chatMessages: many(chatMessages),
  scheduleRuns: many(taskScheduleRuns),
  workflowScheduleRuns: many(workflowScheduleRuns),
}));

export const taskSchedulesRelations = relations(taskSchedules, ({ one, many }) => ({
  user: one(users, {
    fields: [taskSchedules.userWorkosId],
    references: [users.workosUserId],
  }),
  tasks: many(tasks),
  runs: many(taskScheduleRuns),
}));

export const taskScheduleRunsRelations = relations(taskScheduleRuns, ({ one }) => ({
  user: one(users, {
    fields: [taskScheduleRuns.userWorkosId],
    references: [users.workosUserId],
  }),
  schedule: one(taskSchedules, {
    fields: [taskScheduleRuns.scheduleId],
    references: [taskSchedules.id],
  }),
  task: one(tasks, {
    fields: [taskScheduleRuns.taskId],
    references: [tasks.id],
  }),
}));

export const workflowScheduleRunsRelations = relations(workflowScheduleRuns, ({ one }) => ({
  user: one(users, {
    fields: [workflowScheduleRuns.userWorkosId],
    references: [users.workosUserId],
  }),
  workspace: one(workspaces, {
    fields: [workflowScheduleRuns.workspaceId],
    references: [workspaces.id],
  }),
  workflow: one(workflows, {
    fields: [workflowScheduleRuns.workflowId],
    references: [workflows.id],
  }),
  task: one(tasks, {
    fields: [workflowScheduleRuns.taskId],
    references: [tasks.id],
  }),
}));

export const taskMessagesRelations = relations(taskMessages, ({ one, many }) => ({
  user: one(users, {
    fields: [taskMessages.userWorkosId],
    references: [users.workosUserId],
  }),
  task: one(tasks, {
    fields: [taskMessages.taskId],
    references: [tasks.id],
  }),
  events: many(taskEvents),
  modelUsage: many(taskModelUsage),
  toolUsage: many(taskToolUsage),
  sandboxUsage: many(taskSandboxUsage),
}));

export const taskEventsRelations = relations(taskEvents, ({ one }) => ({
  user: one(users, {
    fields: [taskEvents.userWorkosId],
    references: [users.workosUserId],
  }),
  task: one(tasks, {
    fields: [taskEvents.taskId],
    references: [tasks.id],
  }),
  message: one(taskMessages, {
    fields: [taskEvents.messageId],
    references: [taskMessages.id],
  }),
}));

export const taskModelUsageRelations = relations(taskModelUsage, ({ one }) => ({
  user: one(users, {
    fields: [taskModelUsage.userWorkosId],
    references: [users.workosUserId],
  }),
  task: one(tasks, {
    fields: [taskModelUsage.taskId],
    references: [tasks.id],
  }),
  message: one(taskMessages, {
    fields: [taskModelUsage.messageId],
    references: [taskMessages.id],
  }),
}));

export const taskToolUsageRelations = relations(taskToolUsage, ({ one }) => ({
  user: one(users, {
    fields: [taskToolUsage.userWorkosId],
    references: [users.workosUserId],
  }),
  task: one(tasks, {
    fields: [taskToolUsage.taskId],
    references: [tasks.id],
  }),
  message: one(taskMessages, {
    fields: [taskToolUsage.messageId],
    references: [taskMessages.id],
  }),
}));

export const taskSandboxUsageRelations = relations(taskSandboxUsage, ({ one }) => ({
  user: one(users, {
    fields: [taskSandboxUsage.userWorkosId],
    references: [users.workosUserId],
  }),
  task: one(tasks, {
    fields: [taskSandboxUsage.taskId],
    references: [tasks.id],
  }),
  message: one(taskMessages, {
    fields: [taskSandboxUsage.messageId],
    references: [taskMessages.id],
  }),
}));

export const chatSessionsRelations = relations(chatSessions, ({ one, many }) => ({
  user: one(users, {
    fields: [chatSessions.userWorkosId],
    references: [users.workosUserId],
  }),
  task: one(tasks),
  messages: many(chatMessages),
  modelRoutingAttempts: many(chatModelRoutingAttempts),
  sandboxUsage: many(chatSandboxUsage),
  browserProfileSessions: many(browserProfileSessions),
  skills: many(chatSessionSkills),
  brainToolRuns: many(brainToolRuns),
  capabilityRuns: many(capabilityRuns),
  artifacts: many(chatArtifacts),
}));

export const chatSharesRelations = relations(chatShares, ({ one }) => ({
  chatSession: one(chatSessions, {
    fields: [chatShares.chatSessionId],
    references: [chatSessions.id],
  }),
}));

export const capabilityRunsRelations = relations(capabilityRuns, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [capabilityRuns.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [capabilityRuns.userWorkosId],
    references: [users.workosUserId],
  }),
  chatSession: one(chatSessions, {
    fields: [capabilityRuns.chatSessionId],
    references: [chatSessions.id],
  }),
}));

export const chatMessagesRelations = relations(chatMessages, ({ one, many }) => ({
  session: one(chatSessions, {
    fields: [chatMessages.sessionId],
    references: [chatSessions.id],
  }),
  task: one(tasks, {
    fields: [chatMessages.taskId],
    references: [tasks.id],
  }),
  activatedSkills: many(chatSessionSkills),
  sandboxUsage: many(chatSandboxUsage),
  modelRoutingAttempts: many(chatModelRoutingAttempts),
}));

export const chatModelRoutingAttemptsRelations = relations(chatModelRoutingAttempts, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [chatModelRoutingAttempts.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [chatModelRoutingAttempts.userWorkosId],
    references: [users.workosUserId],
  }),
  session: one(chatSessions, {
    fields: [chatModelRoutingAttempts.chatSessionId],
    references: [chatSessions.id],
  }),
  userMessage: one(chatMessages, {
    fields: [chatModelRoutingAttempts.userMessageId],
    references: [chatMessages.id],
  }),
}));

export const chatSandboxUsageRelations = relations(chatSandboxUsage, ({ one }) => ({
  user: one(users, {
    fields: [chatSandboxUsage.userWorkosId],
    references: [users.workosUserId],
  }),
  session: one(chatSessions, {
    fields: [chatSandboxUsage.chatSessionId],
    references: [chatSessions.id],
  }),
  userMessage: one(chatMessages, {
    fields: [chatSandboxUsage.userMessageId],
    references: [chatMessages.id],
  }),
}));

export const browserProfilesRelations = relations(browserProfiles, ({ one, many }) => ({
  user: one(users, {
    fields: [browserProfiles.userWorkosId],
    references: [users.workosUserId],
  }),
  sessions: many(browserProfileSessions),
}));

export const browserProfileSessionsRelations = relations(browserProfileSessions, ({ one }) => ({
  profile: one(browserProfiles, {
    fields: [browserProfileSessions.profileId],
    references: [browserProfiles.id],
  }),
  user: one(users, {
    fields: [browserProfileSessions.userWorkosId],
    references: [users.workosUserId],
  }),
  chatSession: one(chatSessions, {
    fields: [browserProfileSessions.chatSessionId],
    references: [chatSessions.id],
  }),
  userMessage: one(chatMessages, {
    fields: [browserProfileSessions.userMessageId],
    references: [chatMessages.id],
  }),
}));

export const chatSessionSkillsRelations = relations(chatSessionSkills, ({ one }) => ({
  session: one(chatSessions, {
    fields: [chatSessionSkills.chatSessionId],
    references: [chatSessions.id],
  }),
  brain: one(brains, {
    fields: [chatSessionSkills.brainRef],
    references: [brains.id],
  }),
  activatedMessage: one(chatMessages, {
    fields: [chatSessionSkills.activatedMessageId],
    references: [chatMessages.id],
  }),
}));

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Onboarding = typeof onboarding.$inferSelect;
export type OnboardingEmail = typeof onboardingEmails.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type WorkspaceCapability = typeof workspaceCapabilities.$inferSelect;
export type WorkspaceBilling = typeof workspaceBilling.$inferSelect;
export type WorkspaceIngestionReservation = typeof workspaceIngestionReservations.$inferSelect;
export type WikiPage = typeof wikiPages.$inferSelect;
export type WikiPageVersion = typeof wikiPageVersions.$inferSelect;
export type WikiTimelineEntry = typeof wikiTimelineEntries.$inferSelect;
export type WikiLink = typeof wikiLinks.$inferSelect;

export type Brain = typeof brains.$inferSelect;
export type BrainMember = typeof brainMembers.$inferSelect;
export type BrainFolder = typeof brainFolders.$inferSelect;
export type BrainDocument = typeof brainDocuments.$inferSelect;
export type BrainTimelineEntryRecord = typeof brainTimelineEntries.$inferSelect;
export type BrainEdge = typeof brainEdges.$inferSelect;
export type BrainDocumentEmbedding = typeof brainDocumentEmbeddings.$inferSelect;
export type BrainDocumentVersion = typeof brainDocumentVersions.$inferSelect;
export type BrainToolRun = typeof brainToolRuns.$inferSelect;
export type CodexChatSession = typeof codexChatSessions.$inferSelect;
export type CodexChatTurn = typeof codexChatTurns.$inferSelect;
export type ChatCommandIdempotency = typeof chatCommandIdempotency.$inferSelect;
export type RunAttempt = typeof runAttempts.$inferSelect;
export type RunApproval = typeof runApprovals.$inferSelect;
export type RunEvent = typeof runEvents.$inferSelect;
export type ChatArtifact = typeof chatArtifacts.$inferSelect;
export type ChatArtifactVersion = typeof chatArtifactVersions.$inferSelect;
export type CodexChatInteraction = typeof codexChatInteractions.$inferSelect;
export type CodexChatEvent = typeof codexChatEvents.$inferSelect;
export type Integration = typeof integrations.$inferSelect;
export type IntegrationCredential = typeof integrationCredentials.$inferSelect;
export type BrainSourceItem = typeof brainSourceItems.$inferSelect;
export type BrainIngestJob = typeof brainIngestJobs.$inferSelect;
export type CodexCredential = typeof codexCredentials.$inferSelect;
export type ClaudeCodeCredential = typeof claudeCodeCredentials.$inferSelect;
export type CodexDeviceAuthFlow = typeof codexDeviceAuthFlows.$inferSelect;
export type TaskSchedule = typeof taskSchedules.$inferSelect;
export type AutomationCommandIdempotency = typeof automationCommandIdempotency.$inferSelect;
export type BillingCommandIdempotency = typeof billingCommandIdempotency.$inferSelect;
export type TaskScheduleRun = typeof taskScheduleRuns.$inferSelect;
export type WorkflowScheduleRun = typeof workflowScheduleRuns.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskMessage = typeof taskMessages.$inferSelect;
export type TaskEvent = typeof taskEvents.$inferSelect;
export type TaskModelUsage = typeof taskModelUsage.$inferSelect;
export type TaskToolUsage = typeof taskToolUsage.$inferSelect;
export type TaskSandboxUsage = typeof taskSandboxUsage.$inferSelect;
export type ChatSession = typeof chatSessions.$inferSelect;
export type ChatShare = typeof chatShares.$inferSelect;
export type ActionTurn = typeof actionTurns.$inferSelect;
export type CapabilityRun = typeof capabilityRuns.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type ChatModelRoutingAttempt = typeof chatModelRoutingAttempts.$inferSelect;
export type ChatSandboxUsage = typeof chatSandboxUsage.$inferSelect;
export type BrowserProfile = typeof browserProfiles.$inferSelect;
export type BrowserProfileSession = typeof browserProfileSessions.$inferSelect;
export type ChatSessionSkill = typeof chatSessionSkills.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type Skill = typeof skills.$inferSelect;
export type RepoConfig = typeof repoConfigs.$inferSelect;
