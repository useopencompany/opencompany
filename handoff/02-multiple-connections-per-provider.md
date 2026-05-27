# Multiple Connections Per Provider

## Task

Design the app foundation for multiple connections under the same provider. Example: one workspace
connects three Gmail accounts through the Gmail integration.

## Product Requirement

Provider identity is not enough. We need connection identity.

Users and agents should be able to distinguish:

- Gmail: `founder@company.com`
- Gmail: `support@company.com`
- Gmail: `sales@company.com`

All three are provider `gmail`, but they are separate connection instances with separate credentials,
scopes, resources, sync state, and audit history.

## Recommended Model

Treat each row in `workspace_integrations` as a connection instance.

Suggested uniqueness:

- Unique: `(workspace_id, provider, external_id)` when the provider has a stable external account id.
- Allow multiple rows per `(workspace_id, provider)`.

Suggested display fields:

- `connection_label`: user-editable or generated label.
- `account_name`: provider account display name.
- `account_email`: account email when applicable.
- `account_type`: organization, user, service account, installation, etc.

Suggested provider fields:

- `external_id`: stable provider account/install id.
- `scopes`: granted scopes.
- `metadata`: provider-specific account metadata.

## App Behavior

Integration settings should group by provider, then list connections:

- Provider card: "Gmail"
- Connection rows:
  - `founder@company.com`
  - `support@company.com`
  - `sales@company.com`

Agents should bind to a concrete connection or a concrete resource, not just a provider, when the
choice matters.

Examples:

- "Use Gmail support inbox" should bind to the `support@company.com` connection.
- "Use Slack #support" should bind to the Slack channel resource and therefore its parent Slack
  connection.
- "Use GitHub opencompany/web" should bind to the repository resource and its parent GitHub
  installation.

## Agent Config Implication

The `.agent` file should stay human-readable. Do not leak opaque DB ids as the only way to express
intent.

Recommended near-term pattern:

- Keep readable references in `.agent`.
- Store enough normalized config to resolve the connection/resource at runtime.
- For resources, include provider, resource type, stable resource id, display name, and parent
  connection identity when needed.

Do not make "provider only" the runtime binding for providers where multiple accounts are likely.

## Sync Behavior

Each connection syncs independently:

- One bad Gmail account should not mark the whole Gmail provider failed.
- One GitHub installation losing access should not remove other GitHub installations.
- Sync deletes should be scoped to the specific `integration_id`, not all provider resources in the
  workspace.

The current GitHub cleanup behavior deletes other GitHub integrations for the workspace. Replace that
with provider-specific cardinality rules only if we intentionally want a provider to be single
connection.

## Values That Matter

Do not miss these fields:

- Who connected it: `connected_by_user_id`.
- What identity it represents: `account_name`, `account_email`, `account_type`, `external_id`.
- What permissions it has: `scopes`.
- Whether it works: `status`, `status_reason`, `last_synced_at`.
- How to find credentials: `workspace_integration_credentials` rows keyed by connection and kind.
- What users call it: `connection_label`.

## Acceptance Criteria

- One workspace can connect three Gmail accounts.
- The UI can show and disconnect each Gmail account separately.
- Agent/runtime code can resolve a selected Gmail account unambiguously.
- Failed auth for one connection does not affect sibling connections.
- Resource sync cleanup is scoped to one connection unless explicitly configured otherwise.
