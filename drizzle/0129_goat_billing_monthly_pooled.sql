-- Pro moves from per-seat pricing to a flat monthly subscription, so the
-- Stripe seat-quantity sync state on workspace_billing goes away.
ALTER TABLE "goat"."workspace_billing" DROP CONSTRAINT IF EXISTS "goat_workspace_billing_desired_seat_quantity_check";--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_workspace_billing_seat_sync_idx";--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" DROP COLUMN IF EXISTS "desired_seat_quantity";--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" DROP COLUMN IF EXISTS "stripe_seat_quantity";--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" DROP COLUMN IF EXISTS "seat_sync_pending_at";
--> statement-breakpoint
-- Backlog-release sweeps look up workspaces by pending status alone; the
-- existing (workspace_id, status, created_at) index cannot serve that. Pending
-- rows are transient, so this partial index stays near-empty while the
-- reservations table grows unboundedly.
CREATE INDEX IF NOT EXISTS "goat_ingestion_reservations_pending_idx" ON "goat"."workspace_ingestion_reservations" ("workspace_id") WHERE "status" = 'pending';
