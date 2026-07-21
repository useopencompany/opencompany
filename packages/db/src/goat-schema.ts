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

export type GoatHarnessEngine = "opencompany" | "codex";

export type GoatTaskScheduleRunStatus = "pending" | "created" | "failed";

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
  | "attio";
// Ownership is a property of the integration's binding, not a per-connect
// choice. Identity-bound connections (OAuth acting as a person: Gmail,
// Calendar, Slack user token, Linear) are always personal. Installation-bound
// connections (GitHub App org installs, Jamie webhook secrets, the Slack
// answer-bot install) are workspace plumbing: they carry no human identity,
// must survive the connecting admin leaving, and are manageable by any
// workspace admin.
export const WORKSPACE_OWNED_GOAT_INTEGRATION_PROVIDERS = [
  "github",
  "jamie",
  "slack_bot",
] as const satisfies readonly GoatIntegrationProvider[];
export function isWorkspaceOwnedGoatIntegrationProvider(provider: GoatIntegrationProvider) {
  return (
    WORKSPACE_OWNED_GOAT_INTEGRATION_PROVIDERS as readonly GoatIntegrationProvider[]
  ).includes(provider);
}
export type GoatIntegrationStatus = "connected" | "needs_reauth" | "sync_failed" | "disconnected";
export type GoatIntegrationCredentialKind = "oauth_token" | "webhook_secret" | "api_key";
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
export type GoatHubspotObjectType = "contact" | "company" | "deal";
export type GoatHubspotEventAction = "create" | "update";
export type GoatAttioObjectType = "person" | "company" | "deal";
export type GoatAttioEventAction = "create" | "update" | "note";
export type GoatBrainSourceItemIngestStatus = "pending" | "succeeded" | "failed" | "skipped";
export type GoatBrainIngestJobKind = "brain_source_item_ingest" | "brain_agent_ingest";
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
  | "github_clone_repository"
  | "github_shell"
  | "github_status"
  | "github_open_pull_request";

export type GoatWorkspaceRole = "admin" | "member";
export type GoatMcpClient = "claude" | "chatgpt" | "cursor";
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
export type GoatCreditLedgerSource =
  | "starter_grant"
  | "stripe_topup"
  | "chat_model_usage"
  | "frontier_ingest"
  | "ingest_overage"
  | "adjustment";
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
export type GoatBrainDocumentFormat = "markdown" | "pdf" | "docx" | "xlsx" | "image";
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

export type GoatTaskModelUsagePhase = "planner" | "execution";

export type GoatTaskCommentAuthor = "agent" | "user";
export type GoatTaskCommentKind = "status" | "result" | "comment";
export type GoatTaskCommentMetadata = {
  status?: "started" | "failed" | "retrying" | "canceled";
  error?: string;
};

export type GoatChatRole = "user" | "assistant";
export type GoatChatEngine = "opencompany" | "local_codex" | "codex";

export type GoatChatAttachmentKind = "image" | "pdf" | "docx" | "xlsx";
export type GoatChatMessageAttachment = {
  id: string;
  kind: GoatChatAttachmentKind;
  mediaType: string;
  filename: string;
  sizeBytes: number;
  blobPathname: string;
  blobUrl: string;
};

export type GoatLocalCodexSessionStatus =
  | "starting"
  | "idle"
  | "running"
  | "failed"
  | "interrupted"
  | "closed";
export type GoatLocalCodexTurnStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";
export type GoatLocalCodexCommandKind = "start_turn" | "steer" | "interrupt" | "close";
export type GoatLocalCodexCommandStatus = "queued" | "claimed" | "succeeded" | "failed";
export const GOAT_LOCAL_CODEX_EVENT_TYPES = [
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
export type GoatLocalCodexEventType = (typeof GOAT_LOCAL_CODEX_EVENT_TYPES)[number];

export type GoatCodexChatSessionStatus = GoatLocalCodexSessionStatus | "queued";
export type GoatCodexChatTurnStatus = GoatLocalCodexTurnStatus;
export type GoatCodexChatEventType = Exclude<
  GoatLocalCodexEventType,
  "assistant.delta" | "command.output"
>;
export const GOAT_CODEX_CHAT_EVENT_TYPES: readonly GoatCodexChatEventType[] =
  GOAT_LOCAL_CODEX_EVENT_TYPES.filter(
    (eventType): eventType is GoatCodexChatEventType =>
      eventType !== "assistant.delta" && eventType !== "command.output",
  );

export type GoatCodexChatTurnSettings = {
  reasoningEffort?: CodexReasoningEffort;
  planModeReasoningEffort?: CodexReasoningEffort | null;
  goalMode?: {
    objective: string;
    tokenBudget?: number | null;
  } | null;
};

export type GoatCodexChatInteractionStatus = "pending" | "resolved" | "canceled";

export type GoatChatMessageDebugTrace = {
  schemaVersion?:
    | "opencompany.chat.debug.v1"
    | "goat.chat.debug.v1"
    | "goat.local_codex.debug.v1"
    | "goat.local_codex.debug.v2"
    | "goat.codex_chat.debug.v1";
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
    localCodexBetaEnabled: boolean("local_codex_beta_enabled").notNull().default(false),
    chatCapabilitiesBetaEnabled: boolean("chat_capabilities_beta_enabled").notNull().default(false),
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
  // of the ROLE_PROFILES ids in the wizard and seeds the tailored brain folders;
  // `building` is a free-form one-liner describing what they're working on.
  role: text("role"),
  building: text("building"),
  companyDomain: text("company_domain"),
  contextUrls: jsonb("context_urls").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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

// Stripe is authoritative for subscription lifecycle; this row is the local
// entitlement projection used by Goat's latency-sensitive quota checks.
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
    subscriptionStatus: text("subscription_status").$type<GoatStripeSubscriptionStatus>(),
    // Projected from the Stripe subscription item quantity ($18/seat). The
    // pooled Pro ingestion allowance is 300 x seat_quantity per month.
    seatQuantity: integer("seat_quantity").notNull().default(1),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    paymentNeedsAttention: boolean("payment_needs_attention").notNull().default(false),
    lastStripeEventCreated: timestamp("last_stripe_event_created", { withTimezone: true }),
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

// USD credit balance per workspace. Funds usage-based chat, frontier-ingest
// cost pass-through, and Pro ingestion overage. Mirrors the web app's
// workspace_credit_balances, scoped to goat workspaces.
export const goatCreditBalances = goat.table("credit_balances", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => goatWorkspaces.id, { onDelete: "cascade" }),
  balanceCents: integer("balance_cents").notNull().default(0),
  balanceUsdMicros: bigint("balance_usd_micros", { mode: "number" }).notNull().default(0),
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
      sql`${table.source} IN ('starter_grant', 'stripe_topup', 'chat_model_usage', 'frontier_ingest', 'ingest_overage', 'adjustment')`,
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
      sql`${table.format} IN ('markdown', 'pdf', 'docx', 'xlsx', 'image')`,
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
    // github, jamie). NULL = personal integration owned by user_workos_id.
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
    workspaceProviderIdx: index("goat_integrations_workspace_provider_idx").on(
      table.workspaceId,
      table.provider,
    ),
    providerCheck: check(
      "goat_integrations_provider_check",
      sql`${table.provider} IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio')`,
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
      sql`${table.provider} IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'slack_bot', 'hubspot', 'granola', 'fathom', 'attio')`,
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
      sql`${table.provider} IN ('gmail', 'google_calendar', 'google_drive', 'linear', 'github', 'jamie', 'slack', 'hubspot', 'granola', 'fathom', 'attio')`,
    ),
    statusCheck: check(
      "goat_integration_resources_status_check",
      sql`${table.status} IN ('available', 'permission_lost', 'archived', 'sync_failed')`,
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
      sql`${table.sourceType} IN ('meeting', 'run', 'capture', 'asset', 'conversation', 'issue', 'activity', 'thread', 'document')`,
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
      sql`${table.kind} IN ('brain_source_item_ingest', 'brain_agent_ingest')`,
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
    // Model for spawned occurrences; falls back to the app default when null.
    model: text("model").$type<AgentModelId>(),
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
    engine: text("engine").$type<GoatHarnessEngine>().notNull().default("opencompany"),
    status: text("status").$type<GoatTaskStatus>().notNull().default("queued"),
    result: text("result"),
    error: text("error"),
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
    engineCheck: check("goat_tasks_engine_check", sql`${table.engine} IN ('opencompany', 'codex')`),
  }),
);

// Linear-style activity feed on a task. V1 writes agent-authored entries only
// (status transitions and the final result); author stays flexible for future
// user comments.
export const goatTaskComments = goat.table(
  "task_comments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => goatTasks.id, { onDelete: "cascade" }),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    author: text("author").$type<GoatTaskCommentAuthor>().notNull().default("agent"),
    kind: text("kind").$type<GoatTaskCommentKind>().notNull().default("comment"),
    content: text("content").notNull().default(""),
    metadata: jsonb("metadata")
      .$type<GoatTaskCommentMetadata>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskCreatedIdx: index("goat_task_comments_task_created_idx").on(table.taskId, table.createdAt),
    userTaskCreatedIdx: index("goat_task_comments_user_task_created_idx").on(
      table.userWorkosId,
      table.taskId,
      table.createdAt,
    ),
    authorCheck: check(
      "goat_task_comments_author_check",
      sql`${table.author} IN ('agent', 'user')`,
    ),
    kindCheck: check(
      "goat_task_comments_kind_check",
      sql`${table.kind} IN ('status', 'result', 'comment')`,
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
    // Plain pointer (no FK): holds chat_messages ids for session-backed runs.
    messageId: text("message_id"),
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
    // Plain pointer (no FK): holds chat_messages ids for session-backed runs.
    messageId: text("message_id"),
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
    // Plain pointer (no FK): holds chat_messages ids for session-backed runs.
    messageId: text("message_id"),
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
    // Set when this session is a task's run. Doubles as the discriminator that
    // hides run sessions from chat surfaces (recent chats, open-session lookup).
    taskId: text("task_id").references(() => goatTasks.id, { onDelete: "cascade" }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userOpenUpdatedIdx: index("goat_chat_sessions_user_open_updated_idx").on(
      table.userWorkosId,
      table.closedAt,
      table.updatedAt,
    ),
    // One run session per task.
    taskIdx: uniqueIndex("goat_chat_sessions_task_idx")
      .on(table.taskId)
      .where(sql`${table.taskId} IS NOT NULL`),
    engineCheck: check(
      "goat_chat_sessions_engine_check",
      sql`${table.engine} IN ('opencompany', 'local_codex', 'codex')`,
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
    // docx/xlsx extracted text keyed by attachment id; server-side model context
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

export const goatLocalBridges = goat.table(
  "local_bridges",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userLastSeenIdx: index("goat_local_bridges_user_last_seen_idx").on(
      table.userWorkosId,
      table.lastSeenAt,
    ),
    tokenHashIdx: uniqueIndex("goat_local_bridges_token_hash_idx").on(table.tokenHash),
  }),
);

export const goatLocalCodexSessions = goat.table(
  "local_codex_sessions",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => goatChatSessions.id, { onDelete: "cascade" }),
    bridgeId: text("bridge_id").references(() => goatLocalBridges.id, {
      onDelete: "set null",
    }),
    repositoryPath: text("repository_path"),
    worktreePath: text("worktree_path"),
    model: text("model").notNull().default("gpt-5.5"),
    codexThreadId: text("codex_thread_id"),
    activeTurnId: text("active_turn_id"),
    status: text("status").$type<GoatLocalCodexSessionStatus>().notNull().default("starting"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    chatSessionIdx: uniqueIndex("goat_local_codex_sessions_chat_session_idx").on(
      table.chatSessionId,
    ),
    userUpdatedIdx: index("goat_local_codex_sessions_user_updated_idx").on(
      table.userWorkosId,
      table.updatedAt,
    ),
    bridgeIdx: index("goat_local_codex_sessions_bridge_idx").on(table.bridgeId),
    statusCheck: check(
      "goat_local_codex_sessions_status_check",
      sql`${table.status} IN ('starting', 'idle', 'running', 'failed', 'interrupted', 'closed')`,
    ),
  }),
);

export const goatLocalCodexTurns = goat.table(
  "local_codex_turns",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    localCodexSessionId: text("local_codex_session_id")
      .notNull()
      .references(() => goatLocalCodexSessions.id, { onDelete: "cascade" }),
    userMessageId: text("user_message_id")
      .notNull()
      .references(() => goatChatMessages.id, { onDelete: "cascade" }),
    assistantMessageId: text("assistant_message_id")
      .notNull()
      .references(() => goatChatMessages.id, { onDelete: "cascade" }),
    codexTurnId: text("codex_turn_id"),
    status: text("status").$type<GoatLocalCodexTurnStatus>().notNull().default("queued"),
    prompt: text("prompt").notNull(),
    settings: jsonb("settings")
      .$type<GoatCodexChatTurnSettings>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    error: text("error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionCreatedIdx: index("goat_local_codex_turns_session_created_idx").on(
      table.localCodexSessionId,
      table.createdAt,
    ),
    userCreatedIdx: index("goat_local_codex_turns_user_created_idx").on(
      table.userWorkosId,
      table.createdAt,
    ),
    assistantMessageIdx: uniqueIndex("goat_local_codex_turns_assistant_message_idx").on(
      table.assistantMessageId,
    ),
    statusCheck: check(
      "goat_local_codex_turns_status_check",
      sql`${table.status} IN ('queued', 'running', 'completed', 'failed', 'interrupted')`,
    ),
  }),
);

export const goatLocalCodexCommands = goat.table(
  "local_codex_commands",
  {
    id: text("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    localCodexSessionId: text("local_codex_session_id")
      .notNull()
      .references(() => goatLocalCodexSessions.id, { onDelete: "cascade" }),
    localCodexTurnId: text("local_codex_turn_id").references(() => goatLocalCodexTurns.id, {
      onDelete: "set null",
    }),
    bridgeId: text("bridge_id").references(() => goatLocalBridges.id, {
      onDelete: "set null",
    }),
    claimedByBridgeId: text("claimed_by_bridge_id").references(() => goatLocalBridges.id, {
      onDelete: "set null",
    }),
    kind: text("kind").$type<GoatLocalCodexCommandKind>().notNull(),
    status: text("status").$type<GoatLocalCodexCommandStatus>().notNull().default("queued"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    error: text("error"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bridgeQueuedIdx: index("goat_local_codex_commands_bridge_queued_idx").on(
      table.bridgeId,
      table.status,
      table.createdAt,
    ),
    sessionCreatedIdx: index("goat_local_codex_commands_session_created_idx").on(
      table.localCodexSessionId,
      table.createdAt,
    ),
    statusCheck: check(
      "goat_local_codex_commands_status_check",
      sql`${table.status} IN ('queued', 'claimed', 'succeeded', 'failed')`,
    ),
    kindCheck: check(
      "goat_local_codex_commands_kind_check",
      sql`${table.kind} IN ('start_turn', 'steer', 'interrupt', 'close')`,
    ),
  }),
);

export const goatLocalCodexEvents = goat.table(
  "local_codex_events",
  {
    id: serial("id").primaryKey(),
    userWorkosId: text("user_workos_id")
      .notNull()
      .references(() => goatUsers.workosUserId, { onDelete: "cascade" }),
    localCodexSessionId: text("local_codex_session_id")
      .notNull()
      .references(() => goatLocalCodexSessions.id, { onDelete: "cascade" }),
    localCodexTurnId: text("local_codex_turn_id").references(() => goatLocalCodexTurns.id, {
      onDelete: "set null",
    }),
    bridgeId: text("bridge_id").references(() => goatLocalBridges.id, {
      onDelete: "set null",
    }),
    commandId: text("command_id").references(() => goatLocalCodexCommands.id, {
      onDelete: "set null",
    }),
    type: text("type").$type<GoatLocalCodexEventType>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    rawEvent: jsonb("raw_event").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionCreatedIdx: index("goat_local_codex_events_session_created_idx").on(
      table.localCodexSessionId,
      table.createdAt,
    ),
    turnCreatedIdx: index("goat_local_codex_events_turn_created_idx").on(
      table.localCodexTurnId,
      table.createdAt,
    ),
    typeCheck: check(
      "goat_local_codex_events_type_check",
      sql`${table.type} IN (${sql.join(
        GOAT_LOCAL_CODEX_EVENT_TYPES.map((eventType) => sql`${eventType}`),
        sql`, `,
      )})`,
    ),
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
    model: text("model").notNull().default("gpt-5.5"),
    sandboxId: text("sandbox_id"),
    codexThreadId: text("codex_thread_id"),
    activeTurnId: text("active_turn_id"),
    status: text("status").$type<GoatCodexChatSessionStatus>().notNull().default("queued"),
    error: text("error"),
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
    statusCheck: check(
      "goat_codex_chat_sessions_status_check",
      sql`${table.status} IN ('queued', 'starting', 'idle', 'running', 'failed', 'interrupted', 'closed')`,
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
    leaseId: text("lease_id"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
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
  taskModelUsage: many(goatTaskModelUsage),
  taskToolUsage: many(goatTaskToolUsage),
  taskSandboxUsage: many(goatTaskSandboxUsage),
  chatSessions: many(goatChatSessions),
  localBridges: many(goatLocalBridges),
  localCodexSessions: many(goatLocalCodexSessions),
  localCodexTurns: many(goatLocalCodexTurns),
  localCodexCommands: many(goatLocalCodexCommands),
  localCodexEvents: many(goatLocalCodexEvents),
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
  billing: one(goatWorkspaceBilling),
  ingestionReservations: many(goatWorkspaceIngestionReservations),
  brains: many(goatBrains),
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

export const goatLocalBridgesRelations = relations(goatLocalBridges, ({ one, many }) => ({
  user: one(goatUsers, {
    fields: [goatLocalBridges.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  sessions: many(goatLocalCodexSessions),
  events: many(goatLocalCodexEvents),
}));

export const goatLocalCodexSessionsRelations = relations(
  goatLocalCodexSessions,
  ({ one, many }) => ({
    user: one(goatUsers, {
      fields: [goatLocalCodexSessions.userWorkosId],
      references: [goatUsers.workosUserId],
    }),
    chatSession: one(goatChatSessions, {
      fields: [goatLocalCodexSessions.chatSessionId],
      references: [goatChatSessions.id],
    }),
    bridge: one(goatLocalBridges, {
      fields: [goatLocalCodexSessions.bridgeId],
      references: [goatLocalBridges.id],
    }),
    turns: many(goatLocalCodexTurns),
    commands: many(goatLocalCodexCommands),
    events: many(goatLocalCodexEvents),
  }),
);

export const goatLocalCodexTurnsRelations = relations(goatLocalCodexTurns, ({ one, many }) => ({
  user: one(goatUsers, {
    fields: [goatLocalCodexTurns.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  localCodexSession: one(goatLocalCodexSessions, {
    fields: [goatLocalCodexTurns.localCodexSessionId],
    references: [goatLocalCodexSessions.id],
  }),
  userMessage: one(goatChatMessages, {
    fields: [goatLocalCodexTurns.userMessageId],
    references: [goatChatMessages.id],
    relationName: "goat_local_codex_turns_user_message",
  }),
  assistantMessage: one(goatChatMessages, {
    fields: [goatLocalCodexTurns.assistantMessageId],
    references: [goatChatMessages.id],
    relationName: "goat_local_codex_turns_assistant_message",
  }),
  commands: many(goatLocalCodexCommands),
  events: many(goatLocalCodexEvents),
}));

export const goatLocalCodexCommandsRelations = relations(goatLocalCodexCommands, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatLocalCodexCommands.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  localCodexSession: one(goatLocalCodexSessions, {
    fields: [goatLocalCodexCommands.localCodexSessionId],
    references: [goatLocalCodexSessions.id],
  }),
  localCodexTurn: one(goatLocalCodexTurns, {
    fields: [goatLocalCodexCommands.localCodexTurnId],
    references: [goatLocalCodexTurns.id],
  }),
  bridge: one(goatLocalBridges, {
    fields: [goatLocalCodexCommands.bridgeId],
    references: [goatLocalBridges.id],
    relationName: "goat_local_codex_commands_bridge",
  }),
  claimedByBridge: one(goatLocalBridges, {
    fields: [goatLocalCodexCommands.claimedByBridgeId],
    references: [goatLocalBridges.id],
    relationName: "goat_local_codex_commands_claimed_bridge",
  }),
}));

export const goatLocalCodexEventsRelations = relations(goatLocalCodexEvents, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatLocalCodexEvents.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  localCodexSession: one(goatLocalCodexSessions, {
    fields: [goatLocalCodexEvents.localCodexSessionId],
    references: [goatLocalCodexSessions.id],
  }),
  localCodexTurn: one(goatLocalCodexTurns, {
    fields: [goatLocalCodexEvents.localCodexTurnId],
    references: [goatLocalCodexTurns.id],
  }),
  bridge: one(goatLocalBridges, {
    fields: [goatLocalCodexEvents.bridgeId],
    references: [goatLocalBridges.id],
  }),
  command: one(goatLocalCodexCommands, {
    fields: [goatLocalCodexEvents.commandId],
    references: [goatLocalCodexCommands.id],
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
  schedule: one(goatTaskSchedules, {
    fields: [goatTasks.scheduleId],
    references: [goatTaskSchedules.id],
  }),
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

export const goatTaskModelUsageRelations = relations(goatTaskModelUsage, ({ one }) => ({
  user: one(goatUsers, {
    fields: [goatTaskModelUsage.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  task: one(goatTasks, {
    fields: [goatTaskModelUsage.taskId],
    references: [goatTasks.id],
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
}));

export const goatChatSessionsRelations = relations(goatChatSessions, ({ one, many }) => ({
  user: one(goatUsers, {
    fields: [goatChatSessions.userWorkosId],
    references: [goatUsers.workosUserId],
  }),
  messages: many(goatChatMessages),
  skills: many(goatChatSessionSkills),
  brainToolRuns: many(goatBrainToolRuns),
  localCodexSessions: many(goatLocalCodexSessions),
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
  localCodexUserTurns: many(goatLocalCodexTurns, {
    relationName: "goat_local_codex_turns_user_message",
  }),
  localCodexAssistantTurns: many(goatLocalCodexTurns, {
    relationName: "goat_local_codex_turns_assistant_message",
  }),
}));

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
export type GoatWorkspaceMember = typeof goatWorkspaceMembers.$inferSelect;
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
export type GoatLocalBridge = typeof goatLocalBridges.$inferSelect;
export type GoatLocalCodexSession = typeof goatLocalCodexSessions.$inferSelect;
export type GoatLocalCodexTurn = typeof goatLocalCodexTurns.$inferSelect;
export type GoatLocalCodexCommand = typeof goatLocalCodexCommands.$inferSelect;
export type GoatLocalCodexEvent = typeof goatLocalCodexEvents.$inferSelect;
export type GoatCodexChatSession = typeof goatCodexChatSessions.$inferSelect;
export type GoatCodexChatTurn = typeof goatCodexChatTurns.$inferSelect;
export type GoatCodexChatInteraction = typeof goatCodexChatInteractions.$inferSelect;
export type GoatCodexChatEvent = typeof goatCodexChatEvents.$inferSelect;
export type GoatIntegration = typeof goatIntegrations.$inferSelect;
export type GoatIntegrationCredential = typeof goatIntegrationCredentials.$inferSelect;
export type GoatBrainSourceItem = typeof goatBrainSourceItems.$inferSelect;
export type GoatBrainIngestJob = typeof goatBrainIngestJobs.$inferSelect;
export type GoatCodexCredential = typeof goatCodexCredentials.$inferSelect;
export type GoatCodexDeviceAuthFlow = typeof goatCodexDeviceAuthFlows.$inferSelect;
export type GoatTaskSchedule = typeof goatTaskSchedules.$inferSelect;
export type GoatTaskScheduleRun = typeof goatTaskScheduleRuns.$inferSelect;
export type GoatTask = typeof goatTasks.$inferSelect;
export type GoatTaskComment = typeof goatTaskComments.$inferSelect;
export type GoatTaskModelUsage = typeof goatTaskModelUsage.$inferSelect;
export type GoatTaskToolUsage = typeof goatTaskToolUsage.$inferSelect;
export type GoatTaskSandboxUsage = typeof goatTaskSandboxUsage.$inferSelect;
export type GoatChatSession = typeof goatChatSessions.$inferSelect;
export type GoatChatMessage = typeof goatChatMessages.$inferSelect;
export type GoatChatSessionSkill = typeof goatChatSessionSkills.$inferSelect;
