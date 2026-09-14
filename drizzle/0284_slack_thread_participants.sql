-- Align existing subscriptions and future defaults with Slack thread participation.
-- Reversible metadata change: restore workspace_member alongside an application rollback.
ALTER TABLE goat.session_subscriptions ALTER COLUMN policy SET DEFAULT
  '{"acceptedEvents":["human_text_reply"],"authorization":"slack_thread_participant","queue":"serial"}'::jsonb;
--> statement-breakpoint
UPDATE goat.session_subscriptions
SET policy = jsonb_set(policy, '{authorization}', '"slack_thread_participant"'::jsonb)
WHERE source = 'slack_thread' AND policy->>'authorization' = 'workspace_member';
