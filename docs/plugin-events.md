# Plugin events and workflows

A workflow keeps its manual, schedule, or event trigger and its existing step editor. To use an
event, install the official plugin, connect its event account in Settings → Plugins, and switch
on the event. In Workflows, choose **On an event → Plugin → Event**, select an account and any
filters, write the step instructions, and activate the workflow.

The initial supported events are:

| Plugin | Event | Configuration | Delivery |
| --- | --- | --- | --- |
| Linear | Issue created (`issue.created`) | Optional team and status category, including Triage | Signed webhook |
| Granola | Meeting notes ready (`meeting.notes_ready`) | Personal Granola API key | REST polling, normally within five minutes |

Linear's tool connection and event connection are separate. The event OAuth app must have Issue
webhooks enabled and point at the API-owned Linear webhook ingress. Its existing client, secret,
and webhook-signing configuration remain unchanged. Granola's MCP login cannot authorize REST
polling; save a Granola API key in the plugin's Events section. Saving a key does not enable an
event or create an ingestion source. Existing Linear installations show an update action to get
the new optional team and status filters.

## Contract and ownership

Reviewed plugin packages declare `so.opencompany.events`. Each event has an ID, label, description,
delivery mode (`webhook` or `poll`), and filter definitions. Filters are either an
`integration_resource` resolved from the connected account, or a `choice` with declared `{id, name}`
options. The package parser validates declarations. The public protocol preserves them, the editor
renders them, and the database subscription validator rejects unknown filters or choice values.
New providers add their ingress or poll adapter and resource loaders to this same path.

Events default to off and are personal to the installed plugin's owner in the selected workspace.
Activation requires a connected personal event account and that user's enabled plugin event.
The router checks the same subscription when accepting a delivery. It writes an immutable execution
snapshot into the durable workflow event inbox. A unique `(workflow, provider, delivery)` key makes
provider retries idempotent. Provider context is bounded and separated from authored instructions.

The workflow stores its activation time in `workflows.event_activated_at`. Re-activation, switching
accounts, or changing routing filters starts a new activation interval; editing step instructions
or run context keeps the interval. Events older than activation do not start runs. Granola initializes
its cursor on connection, retains pagination progress, and limits stale-note replay to 24 hours.

The runner checks current workflow status, membership, connection, plugin installation, and event
opt-in again before creating a task. Disabling the workflow or its event stops queued deliveries
when the worker next claims them. Work already executing follows the ordinary task cancellation
flow. Task creation and inbox settlement share a transaction; a savepoint rolls back partial task
writes after a database error so the worker can persist bounded retry/backoff. Task association
retains the workflow slug used by the existing task contract.

## Wiki ingestion retirement

Provider-to-Wiki routing, the Wiki ingestion worker, import writers, source settings, and their UI
entry points are removed. Old source/import HTTP endpoints return 410 and bookmarks redirect to
plugin settings. Legacy Brain-specific paths remain scoped to Brain.

Migration `0273_retire_wiki_ingestion` disables Wiki sources, marks queued/running Wiki jobs skipped,
and cancels unfinished Wiki imports. It retains Wiki pages, source records, completed job history,
and Brain imports. Constraints prevent an older API or runner from re-enabling Wiki sources or
queueing new Wiki jobs during a staggered release or application rollback.

An application rollback does not resume canceled ingestion. Restoring it would require an explicit
forward migration to remove the retirement constraints and a reviewed decision about replaying jobs;
never automatically replay the retired backlog. The normal release pipeline applies the migration
before deploying API/runner and then web.

## Verification

Focused UI tests cover plugin selection, optional filters, disconnected accounts, and retained
manual/schedule behavior. Signed Linear ingress tests cover retryable persistence errors. Postgres
integration tests cover activation cutoffs, duplicate deliveries, revoked subscriptions, transactional
rollback/backoff, and the retirement migration's retained pages and rejection of old producers.

Provider references: [Linear webhooks](https://linear.app/developers/webhooks),
[Granola list notes](https://docs.granola.ai/api-reference/list-notes).
