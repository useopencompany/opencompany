-- The legacy-named codex_chat_* tables are the durable per-session turn queue for
-- every Goat chat engine. OpenCompany turns do not allocate a sandbox or engine
-- thread; those already-nullable columns remain coding-engine-only runtime state.
ALTER TABLE "goat"."codex_chat_sessions" DROP CONSTRAINT IF EXISTS "goat_codex_chat_sessions_engine_check";--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_sessions" ADD CONSTRAINT "goat_codex_chat_sessions_engine_check" CHECK ("goat"."codex_chat_sessions"."engine" IN ('opencompany', 'codex', 'claude_code'));
