-- Lease claims are infrastructure handoffs, while recovery attempts start a
-- replacement Codex turn. Track them independently so deploys do not exhaust
-- the execution recovery budget.
ALTER TABLE "goat"."codex_chat_turns" ADD COLUMN "recovery_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- Records successful terminal sandbox parking. A reconciler retries sessions
-- whose terminal DB update survived a hard process kill but whose E2B timeout
-- update did not.
ALTER TABLE "goat"."codex_chat_sessions" ADD COLUMN "sandbox_timeout_armed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "goat_codex_chat_sessions_terminal_sandbox_sweep_idx" ON "goat"."codex_chat_sessions" USING btree ("updated_at","id") WHERE "goat"."codex_chat_sessions"."sandbox_id" IS NOT NULL AND "goat"."codex_chat_sessions"."status" IN ('idle', 'failed', 'interrupted', 'closed') AND ("goat"."codex_chat_sessions"."sandbox_timeout_armed_at" IS NULL OR "goat"."codex_chat_sessions"."sandbox_timeout_armed_at" < "goat"."codex_chat_sessions"."updated_at");--> statement-breakpoint

-- Reattaching to app-server replays persisted turn items. Stable event keys
-- make that replay idempotent without changing the append-only audit history
-- for live deltas and status updates.
ALTER TABLE "goat"."codex_chat_events" ADD COLUMN "event_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_codex_chat_events_turn_event_key_idx" ON "goat"."codex_chat_events" USING btree ("codex_chat_turn_id","event_key") WHERE "goat"."codex_chat_events"."event_key" IS NOT NULL;
