# Integration Credential Storage

## Task

Decide where workspace integration credentials should live. GitHub works today without persisted
workspace OAuth tokens, but Gmail, Slack, Linear, Google Calendar, and similar providers will need
tokens or refresh tokens.

## Recommendation

Use Neon for credential metadata and encrypted credential ciphertext for MVP, with envelope
encryption through a server-side key. Do not store provider credentials in plain JSON metadata.

This keeps the system simple, transactional, and queryable while we are still MVP. It also avoids
introducing a second operational database before we know the integration surface area.

## Why Not Infisical For Per-Workspace OAuth Tokens

Infisical is already the source of truth for runtime and release secrets. It is a good fit for app
configuration secrets, not high-churn user/workspace OAuth tokens.

Per-workspace integration tokens need:

- Creation during interactive OAuth callbacks.
- Rotation after refresh.
- Lookup on every runtime use.
- Deletion on disconnect.
- Auditing against workspace/user/product records.

Keeping that in Postgres is simpler and keeps integration state transactional with the app.

## Suggested Table

Add `workspace_integration_credentials`:

- `id`
- `workspace_id`
- `integration_id`
- `provider`
- `kind`: `oauth_token`, `api_key`, `webhook_secret`, etc.
- `encrypted_payload`
- `encryption_key_version`
- `expires_at`
- `last_rotated_at`
- `created_at`
- `updated_at`

Payload should contain provider-specific secret material only after encryption:

- access token
- refresh token
- token type
- provider token response details that are sensitive

Non-secret values stay on `workspace_integrations`:

- scopes
- account email/name
- provider account id
- status
- last synced time

## Encryption Shape

MVP:

- Add an app-level env var such as `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY`.
- Store it in Infisical `/web` and `/runner`.
- Use AES-GCM or another authenticated encryption primitive.
- Store key version with every credential row.
- Keep the decrypt path server-only.

Later:

- Move the wrapping key to KMS if operational needs justify it.
- Add key rotation jobs.
- Split especially sensitive providers into external vault storage if required by customer/security
  requirements.

## Runtime Access

Credential access should be centralized behind a small service:

- `saveIntegrationCredential`
- `loadIntegrationCredential`
- `deleteIntegrationCredential`
- provider-specific helpers for OAuth refresh

Do not let feature code read encrypted payloads directly. Do not pass raw tokens through logs,
analytics, runtime events, or agent-visible output.

## Status Handling

Credential refresh failures should update the integration row:

- `needs_reauth` for invalid/expired refresh credentials.
- `sync_failed` for temporary provider errors.
- `status_reason` with a sanitized message or code.

Do not delete the integration on auth failure. Keep it visible so admins can repair it.

## Acceptance Criteria

- Tokens are never stored in plaintext.
- Credentials are deleted when an integration connection is disconnected.
- Refresh can update credentials and integration status in one transaction.
- Runner/web code can retrieve tokens without duplicating crypto logic.
- App-level secrets remain in Infisical; workspace/user provider credentials remain encrypted in
  Neon.
