# Integration Resource Lifecycle

## Task

Make integration resources more robust without overengineering. Resources should not disappear or
fail late in confusing ways when provider permissions change.

## Current Issue

Resources are inserted, updated, and deleted during sync. This works for GitHub repositories but is
fragile once agents bind to resources and users expect repairable integration state.

Hard deletes make it harder to explain:

- A repository was removed from a GitHub installation.
- A Gmail account needs reauth.
- A Slack channel was archived.
- A provider API sync failed.

## Recommendation

Prefer status transitions over hard deletes for resources that agents may reference.

Use resource status:

- `available`
- `permission_lost`
- `archived`
- `sync_failed`

Use connection status:

- `connected`
- `needs_reauth`
- `sync_failed`
- `disconnected`

Keep hard deletes for explicit disconnects or data retention cleanup, not normal provider drift.

## Sync Rules

On successful sync:

- Upsert currently visible resources as `available`.
- Update metadata and `last_synced_at`.
- Mark previously known but no-longer-visible resources as `permission_lost` or `archived`, depending
  on provider signal.

On provider auth failure:

- Mark connection `needs_reauth`.
- Do not mutate all resources unless provider response proves they are unavailable.

On temporary provider/API failure:

- Mark connection `sync_failed`.
- Keep previous resource list visible with stale status metadata.

On explicit disconnect:

- Delete credentials.
- Mark connection `disconnected` or delete the integration and cascade resources, depending on
  product/audit requirements.
- For MVP, deletion on explicit disconnect is acceptable if there is no audit requirement yet.

## Runtime Behavior

Before using a resource-bound tool:

- Verify the resource exists for the workspace.
- Verify parent connection status is `connected`.
- Verify resource status is `available`.
- Return a clear repair message if not.

For example:

- "GitHub repository opencompany/web is no longer available to this workspace. Reconnect GitHub or
  update the agent repository mention."
- "Gmail support@company.com needs reauthorization."

## UI Behavior

Settings should show:

- Connected accounts.
- Last sync time.
- Resources with degraded status.
- A reconnect or refresh action where supported.

Agent editor should either:

- Hide unavailable resources from new mentions, or
- Show them as unavailable if existing agents still reference them.

Do not silently remove unavailable resources from existing agent config.

## Minimal Schema Additions

Add to both integrations and resources:

- `status`
- `status_reason`
- `last_synced_at`

Optional later:

- `last_error_code`
- `last_error_at`
- `disconnected_at`

Do not add a separate sync job table unless provider sync becomes slow or needs retries independent
of user requests.

## Acceptance Criteria

- Provider drift does not silently delete resources that agents reference.
- Runtime errors tell users/admins how to repair integration state.
- Temporary provider failures preserve the last known resource list.
- Explicit disconnect still removes access and credentials.
