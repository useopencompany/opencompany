-- Subscription and invoice events are separate Stripe streams and can arrive
-- out of order. Track their clocks independently so a newer invoice event
-- cannot make an authoritative subscription projection look stale.
ALTER TABLE "goat"."workspace_billing" ADD COLUMN IF NOT EXISTS "last_stripe_invoice_event_created" timestamp with time zone;
--> statement-breakpoint
-- v3 subscriptions used billingProduct=goat. Keep their lifecycle visible but
-- never let them confer the new flat-workspace Pro entitlement.
ALTER TABLE "goat"."workspace_billing" ADD COLUMN IF NOT EXISTS "stripe_product_key" text;
