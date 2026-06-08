-- Preview-seed sanitization (issue #351).
--
-- Run this ONCE against the `preview-seed` Neon branch (NOT prod) after forking it from
-- production, so per-PR previews never contain prod PII or secrets. Re-run after every
-- re-fork/refresh of the seed.
--
--   psql "$SEED_DIRECT_URL" -f scripts/sql/preview-seed-sanitize.sql
--   # or paste into the Neon Console SQL editor for the preview-seed branch
--
-- ⚠️ REVIEW before trusting: the column list below was derived from the schema on
-- 2026-06-07. If the schema changes, update this file (a missed PII column is a real
-- leak). Statements are ordered children-before-parents and are safe to re-run.
--
-- Strategy: scrub identifiers/PII in place (keeps referential structure so previews boot),
-- and DELETE secret/credential/financial rows outright (previews start with no connected
-- integrations — they wire up their own sandbox creds).

BEGIN;

-- 1) Secrets & credentials — delete entirely (encrypted payloads, tokens).
DELETE FROM workspace_integration_credentials;
DELETE FROM workspace_mcp_credentials;
DELETE FROM stripe_checkout_sessions;
DELETE FROM user_avatars;

-- 2) Users — scrub email/name/avatar and break the WorkOS linkage so seeded identities
--    can't be impersonated; real preview logins create fresh users.
UPDATE users
SET email = 'user-' || id || '@preview.invalid',
    first_name = 'Preview',
    last_name = 'User',
    avatar_url = NULL,
    workos_user_id = 'preview-' || id;

-- 3) Workspaces — break the WorkOS org linkage.
UPDATE workspaces
SET workos_organization_id = 'preview-' || id;

-- 4) Integration connection metadata (the secrets themselves were deleted above).
--    external_id is NOT NULL and carries a unique (workspace, provider, external_id)
--    index, so scrub it to a per-row placeholder rather than NULL.
UPDATE workspace_integrations
SET account_email = NULL,
    account_name = NULL,
    external_id = 'preview-' || id;

UPDATE workspace_mcp_servers
SET endpoint_url = 'https://mcp.preview.invalid';

UPDATE workspace_slack_channels
SET slack_channel_id = NULL,
    slack_team_id = NULL,
    invite_url = NULL;

-- 5) User-authored content — redact (keep rows so sessions/brain/files still resolve).
UPDATE agent_session_messages
SET content = '[redacted in preview seed]',
    model_message = NULL;

UPDATE agent_tool_approvals
SET input_preview = '[redacted in preview seed]';

UPDATE agent_session_questions
SET questions = '[]'::jsonb,
    answers = '[]'::jsonb;

UPDATE brain_files SET content = '';
UPDATE agent_files SET content = '';

UPDATE onboarding_responses
SET heard_from_detail = NULL,
    help_areas = '{}';

-- 6) External resource identifiers (E2B sandboxes, GitHub/repo + artifact references).
UPDATE agent_sessions SET e2b_sandbox_id = NULL;

UPDATE agent_session_artifacts
SET repository_full_name = NULL,
    external_id = NULL,
    url = NULL;

COMMIT;
