# Workspace Integrations DB Foundation

## Task

Rethink the workspace integration database model from first principles before adding more providers
and tools. We are still in MVP, so hard refactors are acceptable if they give us a cleaner base.

## Current Shape

The current core is:

- `workspace_integrations`: one connected provider account or installation.
- `workspace_integration_resources`: resources exposed by a connected provider account, such as
  GitHub repositories.
- Static runtime tools live in `@opencompany/agent-runtime`, not in workspace DB tables.

This direction is good, but the current schema is too GitHub-shaped in behavior and does not yet
fully protect parent/child integrity.

## First Principles

The product needs to answer five questions cleanly:

1. What provider has this workspace connected?
2. Which concrete account or tenant did they connect?
3. Which resources are available from that connection?
4. Which agents/tools are allowed to use those resources?
5. Is the connection/resource currently usable?

That suggests keeping integrations and resources separate, but strengthening their contract.

## Recommended Foundation

Keep these primary tables:

- `workspace_integrations`
- `workspace_integration_resources`

Refine `workspace_integrations` to represent a single connection instance:

- `id`
- `workspace_id`
- `provider`
- `external_id`: provider connection/account/install id when available.
- `connection_label`: user/admin-visible label, for example "Louis Gmail" or "Acme GitHub".
- `account_name`
- `account_email`
- `account_type`
- `connected_by_user_id`
- `status`: `connected`, `needs_reauth`, `sync_failed`, `disconnected`
- `status_reason`
- `last_synced_at`
- `scopes` as JSONB
- `metadata` as JSONB
- timestamps

Refine `workspace_integration_resources` to represent a provider object available through one
connection:

- `id`
- `workspace_id`
- `integration_id`
- `provider`
- `resource_type`
- `external_id`
- `name`
- `display_name`
- `status`: `available`, `permission_lost`, `archived`, `sync_failed`
- `status_reason`
- `last_synced_at`
- `selected_at`
- `metadata` as JSONB
- timestamps

## Integrity Fix

Resources duplicate `workspace_id` and `provider` for query performance. That is acceptable, but the
database should make invalid states impossible.

Add one of these:

- Composite FK from resource `(integration_id, workspace_id, provider)` to integration
  `(id, workspace_id, provider)`.
- Or stop storing duplicated `workspace_id` and `provider` on resources and query through the parent.

For MVP, prefer the composite FK. It preserves current query ergonomics while closing the integrity
gap.

## MVP Scope

Do now:

- Add the missing connection/resource status fields.
- Add `connection_label`, `account_email`, `connected_by_user_id`, `last_synced_at`, and
  `scopes`.
- Add parent/child integrity.
- Make GitHub use the generic fields instead of special assumptions where practical.

Do not do yet:

- Build a full provider registry table unless provider metadata starts changing at runtime.
- Build admin tool gating UI.
- Normalize provider-specific metadata into separate tables unless a provider needs hot-path
  relational queries.

## Migration Notes

This is a worthwhile hard refactor before more integrations land. Existing GitHub rows can migrate
cleanly:

- `account_name` stays as-is.
- `external_id` remains the installation id.
- `connection_label` can default to `account_name` or `GitHub`.
- `status` defaults to `connected`.
- resource `status` defaults to `available`.
- `last_synced_at` can use existing `updated_at`.

## Acceptance Criteria

- A workspace can store multiple connections for the same provider.
- A resource cannot point at an integration from another workspace/provider.
- Connection and resource health can be represented without deleting rows.
- Existing GitHub integration behavior still works.
- The model can support Gmail accounts, Slack workspaces/channels, Linear teams/projects, and GitHub
  installations without provider-specific DB tables.
