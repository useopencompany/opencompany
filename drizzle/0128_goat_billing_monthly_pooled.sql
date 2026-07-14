-- Pro moves from per-seat pricing to a flat monthly subscription, so the
-- Stripe seat-quantity sync state on workspace_billing goes away.
ALTER TABLE "goat"."workspace_billing" DROP CONSTRAINT IF EXISTS "goat_workspace_billing_desired_seat_quantity_check";--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_workspace_billing_seat_sync_idx";--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" DROP COLUMN IF EXISTS "desired_seat_quantity";--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" DROP COLUMN IF EXISTS "stripe_seat_quantity";--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" DROP COLUMN IF EXISTS "seat_sync_pending_at";
