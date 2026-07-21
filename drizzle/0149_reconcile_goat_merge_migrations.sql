-- Branch-local databases may already have recorded the old task-board
-- migration timestamps, causing Drizzle to skip main's 0145 billing and 0146
-- Codex handoff migrations. Reapply those schema changes idempotently after
-- the renumbered task migrations so every database converges on the same state.
ALTER TABLE "goat"."credit_ledger" DROP CONSTRAINT IF EXISTS "goat_credit_ledger_source_check";--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" ADD CONSTRAINT "goat_credit_ledger_source_check" CHECK ("source" IN ('starter_grant', 'stripe_topup', 'chat_model_usage', 'frontier_ingest', 'ingest_overage', 'ingest_model_usage', 'ingest_fee', 'adjustment')) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" VALIDATE CONSTRAINT "goat_credit_ledger_source_check";--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" ADD COLUMN IF NOT EXISTS "auto_refill_enabled" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" ADD COLUMN IF NOT EXISTS "auto_refill_amount_cents" integer NOT NULL DEFAULT 2000;--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" ADD COLUMN IF NOT EXISTS "auto_refill_payment_method_id" text;--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" ADD COLUMN IF NOT EXISTS "auto_refill_in_flight_at" timestamptz;--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" ADD COLUMN IF NOT EXISTS "auto_refill_last_attempt_at" timestamptz;--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" ADD COLUMN IF NOT EXISTS "auto_refill_last_error" text;--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" DROP CONSTRAINT IF EXISTS "goat_workspace_billing_auto_refill_amount_check";--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" ADD CONSTRAINT "goat_workspace_billing_auto_refill_amount_check" CHECK ("auto_refill_amount_cents" >= 500);--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_turns" ADD COLUMN IF NOT EXISTS "recovery_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_sessions" ADD COLUMN IF NOT EXISTS "sandbox_timeout_armed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_codex_chat_sessions_terminal_sandbox_sweep_idx" ON "goat"."codex_chat_sessions" USING btree ("updated_at","id") WHERE "goat"."codex_chat_sessions"."sandbox_id" IS NOT NULL AND "goat"."codex_chat_sessions"."status" IN ('idle', 'failed', 'interrupted', 'closed') AND ("goat"."codex_chat_sessions"."sandbox_timeout_armed_at" IS NULL OR "goat"."codex_chat_sessions"."sandbox_timeout_armed_at" < "goat"."codex_chat_sessions"."updated_at");--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_events" ADD COLUMN IF NOT EXISTS "event_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_codex_chat_events_turn_event_key_idx" ON "goat"."codex_chat_events" USING btree ("codex_chat_turn_id","event_key") WHERE "goat"."codex_chat_events"."event_key" IS NOT NULL;
