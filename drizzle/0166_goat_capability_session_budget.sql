ALTER TABLE "goat"."workspaces" ADD COLUMN IF NOT EXISTS "capability_session_budget_usd_micros" bigint;
--> statement-breakpoint
ALTER TABLE "goat"."workspaces" ADD CONSTRAINT "goat_workspaces_capability_session_budget_check"
  CHECK ("capability_session_budget_usd_micros" IS NULL OR "capability_session_budget_usd_micros" > 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "goat"."workspaces" VALIDATE CONSTRAINT "goat_workspaces_capability_session_budget_check";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_capability_runs_chat_session_idx" ON "goat"."capability_runs" ("chat_session_id");
