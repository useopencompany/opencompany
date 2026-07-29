-- Workspace Stripe connections now use Stripe Apps OAuth. Purge credentials
-- collected by the former restricted-key flow and require those workspaces to
-- authorize the read-only app. GOAT_STRIPE_API_KEY is a separate billing env
-- secret and is not stored in this table.
DELETE FROM "goat"."integration_credentials"
WHERE "provider" = 'stripe' AND "kind" = 'api_key';--> statement-breakpoint
UPDATE "goat"."integrations"
SET
  "status" = 'needs_reauth',
  "status_reason" = 'Reconnect Stripe to authorize read-only access.',
  "updated_at" = NOW()
WHERE
  "provider" = 'stripe'
  AND "account_type" IN ('stripe_live_restricted_key', 'stripe_test_restricted_key');
