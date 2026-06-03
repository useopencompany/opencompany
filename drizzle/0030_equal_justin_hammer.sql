ALTER TABLE "agent_schedule_runs" ADD COLUMN "reservation_token" text;--> statement-breakpoint
ALTER TABLE "agent_schedule_runs" ADD COLUMN "pending_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "agent_schedule_runs"
SET "pending_expires_at" = "updated_at"
WHERE "status" = 'pending' AND "pending_expires_at" IS NULL;
