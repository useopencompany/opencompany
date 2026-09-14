-- The sandbox-size release was reverted before production rollout because its
-- required E2B templates had not been built. Keep migration history forward-only
-- for databases that already applied 0276 while returning the schema to the
-- single-template model.

ALTER TABLE "goat"."codex_chat_sessions" DROP CONSTRAINT "goat_codex_chat_sessions_sandbox_size_check";--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_sessions" DROP COLUMN "sandbox_size";--> statement-breakpoint
ALTER TABLE "goat"."workspaces" DROP CONSTRAINT "goat_workspaces_sandbox_size_check";--> statement-breakpoint
ALTER TABLE "goat"."workspaces" DROP COLUMN "sandbox_size";
