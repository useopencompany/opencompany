# Analytics

opencompany uses PostHog through the shared `@opencompany/analytics` package. Product code should
not import PostHog directly.

The marketing site sends its basic traffic and conversion signals to the same current-product
project. Keeping both surfaces in one project keeps acquisition and activation reporting together
without maintaining a second analytics sink.

## Event registries

`packages/analytics/src/product-events.ts` is the current product registry. It defines every event
name, allowed property shape, description, and safe property keys. Events cover app and onboarding
activity, Chat and Task use, plugins, connections and Brain ingestion, model usage and spend, and billing
top-ups.

`packages/analytics/src/events.ts` is a separate billing-compatibility registry. It exists for the
shared Stripe and retained billing contracts and is not a second product analytics surface. Do not
add ordinary product events to it.

`packages/analytics/src/marketing-events.ts` contains the intentionally small marketing registry:
`marketing_clicked_signup` and `marketing_clicked_demo`. PostHog supplies page views, page leaves,
referrers, and campaign attribution automatically. Autocapture, session replay, heatmaps, surveys,
feature flags, browser performance, dead/rage clicks, and exception capture are disabled.

There is no separate `chat_started` event: the first Message is represented by
`chat_message_sent.is_first_message`. Before adding a new event, check the registry for an existing
signal that already answers the question.

## Plugin and connection reporting

Plugins are workspace-installed packages. Connections are authorized provider accounts; installing a
plugin does not create a connection, and removing a plugin does not disconnect its accounts.

| Question | Signal | Counting guidance |
| --- | --- | --- |
| Do users discover plugins? | `plugin_catalog_viewed` | Unique users/workspaces opening the catalog. |
| Do they evaluate a plugin? | `plugin_import_previewed` | Successful server previews, including custom imports; group by `plugin_name`. Repeated previews are expected. |
| Do they install it? | `plugin_installed` | Successful installs, excluding idempotent replays. `plugin_id` identifies the installation; `plugin_kind`, `skill_count`, and `mcp_server_count` describe its contents. |
| Do they connect accounts? | `connection_added` | Successful authorization, including reconnects. Count distinct `connection_id` for unique accounts, split by `provider`. |
| Do connected plugins deliver value? | `plugin_tool_call_completed` | Remote MCP calls actually dispatched by the shared plugin gateway. Filter `outcome = success` for usage; compare error share and `duration_ms` by plugin, capability, and engine. |
| Do they stop using them? | `plugin_removed`, `connection_removed` | Successful explicit removals, recorded after persistence. These measure different actions. |

Use catalog → preview → install as an exploration funnel. Measure adoption as workspaces with a
successful plugin tool call, and retention as those workspaces using plugins again in later weeks.
Connections may predate installation and may be shared by multiple plugins, so do not require
install → connection → use to happen in that order. Personal authorization paths without workspace
context emit user-level connections; do not infer workspace membership from those events.

Tool-call events exclude catalog discovery, blocked permissions, missing credentials, and failures
before dispatch. They contain no tool names, arguments, outputs, or error text. They cover remote MCP
plugins through the shared gateway across engines, not local stdio MCP or skill execution. A skill-only
installation is adoption intent, not evidence that the skill was used. Existing chat/task events remain
the broader activity signals. Removal events do not cover provider-side revocation or token expiry.
Workspace Stripe removals have no `connection_id`; other removals identify the deleted connection.

### Event-name migration

`connection_added` replaces `integration_added` at this release. New code emits only the new event;
there is no dual emission or historical rewrite. Existing dashboards/insights that filter on
`integration_added` need to include both names for a continuous historical authorization series.
The old event lacks `connection_id`, so unique-account reporting is available only after this change.
Keep `provider` values stable (for example `github_user`, `google_drive`, and `x_account`); these are
provider identifiers, while `plugin_name` identifies the installed package. Plugin names should not be
joined to provider IDs without the mapping in `packages/agent/src/plugin-gateway.ts`.

## Privacy rules

Event payloads may contain internal entity IDs, selected enum values, counts, durations, model
metadata, and changed field names. opencompany identifies a person with the internal WorkOS user
ID; the allowlisted workspace and display fields may be set as person properties.

Do not send prompts, Messages, tool arguments or output, provider payloads, file contents, company
URLs, free-text onboarding answers, credentials, or other user-authored content. Lengths and counts
are acceptable where the registry permits them. Person properties must not be copied into ordinary
event properties unless the registry explicitly includes the field.

## Configuration

The current product project uses:

```bash
NEXT_PUBLIC_OPENCOMPANY_POSTHOG_TOKEN=""
NEXT_PUBLIC_OPENCOMPANY_POSTHOG_HOST=""
NEXT_PUBLIC_ANALYTICS_DEBUG="false"
```

The values must be available in every runtime that emits current product events: web, marketing,
API, or runner as required by the release checks. Billing-compatibility values use
`NEXT_PUBLIC_POSTHOG_TOKEN` and `NEXT_PUBLIC_POSTHOG_HOST` only in the retained emitters that still
consume that registry.

Analytics is optional for ordinary local development. Missing values make the package a no-op.
Set `NEXT_PUBLIC_ANALYTICS_DEBUG=true` to log sanitized event names and property keys locally
without requiring a PostHog project.

## Verification

With product PostHog values missing, exercise the changed flow and confirm there are no
analytics-related failures. With debug enabled, confirm logs contain only properties registered in
`product-events.ts` and never print values for sensitive person fields. With hosted values, confirm the
event arrives in the product project once and does not also enter the billing-compatibility project.
