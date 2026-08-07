// Storage contract for the runner's LLM broker: physical table names, columns, and
// constraints in the public schema must stay exactly as deployed (drizzle no longer
// generates migrations for the retired legacy tables these once referenced).
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Per-delegation broker tokens: auth, lifecycle, and denormalized usage totals.
// session_id / workspace_id / settled_tool_usage_id keep their database-level
// foreign keys to the legacy agent_sessions / workspaces / agent_session_tool_usage
// tables; those tables are no longer defined in code, so the FKs are not modeled here.
export const llmBrokerTokens = pgTable(
  "llm_broker_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    sessionId: text("session_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
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
    settledToolUsageId: integer("settled_tool_usage_id"),
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
