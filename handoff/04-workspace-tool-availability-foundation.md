# Workspace Tool Availability Foundation

## Task

Plan for future admin-configurable tool availability while keeping MVP simple. Today every workspace
can use every platform tool.

## Current Model

Runtime tools are static code definitions in `@opencompany/agent-runtime`. Agent config stores
selected tools, such as `exa` or `amp`. Workspace integration DB tables store connected provider
accounts/resources, not tool availability.

This is the right MVP default.

## Recommendation

Do not add a full workspace tool administration system yet. Instead, make the runtime/tool catalog
ready for one later by keeping tool definitions explicit and stable.

For now:

- All workspaces can use all globally supported tools.
- Tools that require provider resources must validate the needed connection/resource at runtime.
- Tools that require platform env vars should fail with clear setup errors.

Later, add a small `workspace_tool_settings` table only when admin control is needed.

## Future Table

If/when needed:

`workspace_tool_settings`

- `workspace_id`
- `tool_id`
- `enabled`
- `configured_by_user_id`
- `settings` JSONB
- timestamps

Uniqueness:

- `(workspace_id, tool_id)`

Default behavior:

- Missing row means default enabled or disabled according to the static tool catalog.
- For current product direction, default should be enabled.

## Tool Catalog Requirements

To make future gating easy, each static tool definition should have:

- Stable `id`.
- Human label and description.
- Runtime tool names it exposes.
- Required provider/resource type when applicable.
- Whether it uses platform credentials or workspace credentials.
- Optional feature flag or rollout metadata only if actually needed.

Do not turn the catalog into database data until admins need runtime mutability.

## Agent Editor Behavior

MVP:

- Show all supported tools.
- For resource-bound tools, guide users toward selecting a resource.
- If a tool is selected without a needed resource, preserve the config but fail clearly or prompt
  before run where practical.

Future:

- Filter hidden/disabled tools from mention suggestions.
- Keep existing agents readable if an admin disables a tool later.
- Runtime should report "tool disabled for this workspace" instead of silently removing behavior.

## Non-Goals

- Do not build billing/plan gating in this task.
- Do not add per-user tool permissions yet.
- Do not make tools dynamically installable from DB.

## Acceptance Criteria

- MVP behavior remains: every workspace can use every supported tool.
- Adding admin tool controls later requires adding one small table and a resolver, not rewriting
  agent config.
- Resource-bound tools still verify concrete integration access before use.
