// Storage contract for the legacy-product billing tables the shared Stripe webhook
// still writes (apps/app/lib/billing/legacy-*.ts). Physical table names, columns,
// and constraints in the public schema must stay exactly as deployed; these tables
// are retirement-tracked and go away when legacy billing is wound down.
// workspace_id / user_id keep their database-level foreign keys to the legacy
// workspaces / users tables; those tables are no longer defined in code, so the
// FKs are not modeled here.
import { sql } from "drizzle-orm";
import { bigint, boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// Per-workspace billing controls: weekly spending limit (pauses runs at the cap)
// and automatic refill (off-session top-up via a saved card when the balance runs
// low). One row per workspace; absent row means "all defaults / disabled".
export const workspaceBillingSettings = pgTable("workspace_billing_settings", {
  workspaceId: text("workspace_id").primaryKey(),
  // Weekly spend limit toggle. NULL limit below = no limit configured.
  spendLimitEnabled: boolean("spend_limit_enabled").notNull().default(false),
  // NULL = no limit configured. Enforced only when spendLimitEnabled is true.
  weeklySpendLimitUsdMicros: bigint("weekly_spend_limit_usd_micros", { mode: "number" }),
  // Daily spend limit. Independent of the weekly toggle above; when enabled and a
  // limit is set, runs are blocked once spend since UTC midnight reaches the cap.
  dailySpendLimitEnabled: boolean("daily_spend_limit_enabled").notNull().default(false),
  // NULL = no daily limit configured. Enforced only when dailySpendLimitEnabled is true.
  dailySpendLimitUsdMicros: bigint("daily_spend_limit_usd_micros", { mode: "number" }),
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

// Audit + idempotency record for each off-session auto-refill charge. Crediting is
// guarded by a conditional status transition (pending -> succeeded) so webhook
// retries never double-credit.
export const autoRefillAttempts = pgTable(
  "auto_refill_attempts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id"),
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

export type WorkspaceBillingSettings = typeof workspaceBillingSettings.$inferSelect;
export type AutoRefillAttempt = typeof autoRefillAttempts.$inferSelect;
