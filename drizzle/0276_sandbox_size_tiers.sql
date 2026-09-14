-- Makes the cloud sandbox machine size a workspace setting (PRO-197).
--
-- E2B fixes vCPU and RAM per template, so a size is a template alias, not a
-- per-sandbox override. Two columns carry the choice:
--
--   workspaces.sandbox_size          the workspace default, owned by admins
--   codex_chat_sessions.sandbox_size the size a session was created with
--
-- The session column is pinned at creation and never follows a later workspace
-- change, so resizing a workspace cannot resize work that is already running.
--
-- Every sandbox before this change ran on the single baked-in 8 vCPU / 16 GiB
-- allocation, so existing sessions backfill to 'large'. New rows default to
-- 'standard', which is also the workspace default for existing workspaces:
-- a workspace only spends on the larger tier once an admin asks for it.

ALTER TABLE "goat"."workspaces" ADD COLUMN "sandbox_size" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."workspaces" ADD CONSTRAINT "goat_workspaces_sandbox_size_check" CHECK ("sandbox_size" IN ('small', 'standard', 'large'));--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_sessions" ADD COLUMN "sandbox_size" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
UPDATE "goat"."codex_chat_sessions" SET "sandbox_size" = 'large';--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_sessions" ADD CONSTRAINT "goat_codex_chat_sessions_sandbox_size_check" CHECK ("sandbox_size" IN ('small', 'standard', 'large'));
