# ADR 0009: Poll-Delivered Plugin Events

- Status: Accepted
- Date: 2026-09-11
- Extends: [ADR 0008](./0008-plugin-event-subscriptions.md)

## Context

ADR 0008 gave plugins a declarative event vocabulary but fixed one delivery mode: a signed provider
webhook. That conflated "this provider emits this event" with "the platform learns about it through
an HTTP POST", and it left the routing, matching, and goal composition inside the Linear module.

Granola is the case that separates the two. Its public API does emit `note.generated`,
`note.edited`, and `note.access_granted` over Standard Webhooks, but only on Business and
Enterprise plans, and only after a per-connection endpoint registration whose signing secret is
returned exactly once. The MCP connection cannot register anything: MCP is request/response
tooling with no subscription primitive. Meanwhile the platform already syncs every connected
Granola account on a five-minute cursor poll for Wiki ingestion, on every plan.

## Decision

`so.opencompany.events` accepts a second platform-supported delivery mode, `poll`. A `poll` event
is discovered by a platform poller that already syncs the provider instead of by a signed
delivery. The mode remains the plugin's statement about how its provider emits, not a
per-workspace setting, and the trusted-source gate is unchanged. Event ids accept `_` alongside
`.` and `-` so providers can keep their own naming (`note.access_granted`), matching the filter id
rule.

Provider-neutral routing moved out of the Linear module into `@opencompany/db/workflow-event-routes`.
An adapter — a webhook ingress or a poller — resolves its connected integrations, asks for matching
routes, and supplies two values: a delivery id stable across redeliveries, and a context block
describing what happened. The shared composer wraps that context in a provider tag, neutralizes a
smuggled closing tag, and truncates to the run budget without dropping the tag. Declared filters
are equality matches on an integration resource id; an unset optional filter matches everything.

Both delivery modes converge on the same durable inbox and the same unique
`(workflow, provider, delivery)` index. For a poller the delivery id is the resource id, so
re-seeing a note on a later pass is a no-op rather than a duplicate task.

The trigger editor renders whatever a declaration says: the enabled events across every installed
plugin, the connected accounts for the chosen provider, and one picker per declared filter.
Resolving a filter's `resourceType` to real options stays platform code, registered per
`<provider>:<resourceType>`. A provider whose event binds to a connection other than the one its
plugin page offers names that destination in its plugin metadata.

The Granola package declares one event, `meeting.notes_ready`, with `poll` delivery and no filters.
The existing Granola poll worker is its adapter; polling now also covers accounts that have an
event-triggered workflow but no Wiki or Brain source.

## Consequences

Adding a poll-backed event requires a reviewed manifest declaration plus a few lines in an existing
poller, and no new public ingress, secret material, or plan requirement. Latency is the poll
interval — five minutes for Granola — which suits "the meeting finished, do the follow-up" and
would not suit anything interactive.

Polling and pushing differ in what a resumed connection sees. A poller's cursor keeps a backlog,
which ingestion is happy to catch up on but which an event must not replay as one agent task per
historical resource. A poll-backed event therefore only fires for a resource the provider touched
recently; older ones are still ingested, never triggered. This matches how the providers themselves
behave — Granola does not replay deliveries missed while an endpoint was disabled.

Folder scoping for Granola stays out. In poll delivery the platform sees a note's direct
`folder_membership`, which cannot reproduce the subfolder semantics of Granola's own webhook filter
without fetching the folder tree. Adding it later is a manifest edit plus a resource resolver.

Granola webhooks remain unused. Adopting them would mean per-connection endpoint registration,
storing a signing secret we can only read once, and a feature that silently excludes every account
below Business — for a latency win that this event does not need.
