# ADR 0016: Gmail Email-Received Events

- Status: Accepted
- Date: 2026-09-16
- Extends: [ADR 0009](./0009-poll-delivered-plugin-events.md)

## Context

The three events shipped so far are all low-volume and self-scoping. A meeting ends a few times a
day; an issue is created deliberately by a teammate. An arriving email is neither. It is the
highest-volume event source a small team has, most of it is not worth a workflow, and none of it is
written by someone the workspace trusts.

Gmail also has no plain webhook. Push notifications require a Google Cloud Pub/Sub topic the
workspace does not own, a `users.watch` call per mailbox, and a renewal before the seven-day
expiry — real standing infrastructure and a new failure mode per mailbox. What already exists is
the history poller ADR 0009's `poll` delivery mode was defined for: `users.history` on a per-account
cursor with claim/cooldown, an expiry reset, and a documented gap when Gmail stops retaining the
cursor.

## Decision

The Gmail package declares one `poll` event, `email.received`, delivered by the existing history
poller. `listGmailPollCandidates` widens from "has an enabled ingestion source" to "has an enabled
ingestion source or an active event trigger", the same shape the Granola poller uses, and the two
consumers are resolved independently per pass: an event-only account buffers nothing, because a
buffered row nothing will ever flush is waste.

Latency is the poll interval, which this change raises from three minutes to five. The thread flush
already batches behind a quiet period, so ingestion never noticed the difference, and halving the
API traffic per mailbox is worth more than two minutes on a trigger nobody watches a clock for.

### One filter, and why it is a label

The package declares one optional `integration_resource` filter, `label`, resolved through the same
`<provider>:<resourceType>` loader registry Linear's team and Granola's folder filters use.

The filters an author actually wants — from this person, from this domain, subject contains this —
are text predicates, and the event contract has no text filter kind. Adding one means new semantics
(equality against contains, case, multiple values) in the package parser, the protocol DTO, the
subscription validator, the editor, and the matcher, on a contract three providers already depend
on. It would also duplicate, worse, a matching engine every Gmail user already has: Gmail's own
filter rules express all of those predicates and apply a label when they match. Matching that label
inherits the whole engine for the cost of one resource loader.

The picker drops labels that cannot describe an arriving message: the poller's existing noise floor
(`DRAFT`, `SPAM`, `TRASH`, `CHAT`), `SENT`, and the two a person applies by hand afterwards
(`STARRED`, `UNREAD`). `INBOX` stays, because a Gmail filter that skips the inbox makes it a real
narrowing. A system label this build has no display name for is dropped rather than shown as a raw
id.

### Bounding volume

`email.received` never fires on mail the mailbox sent. That is the filter's plain meaning, and it is
also what stops a workflow that replies by email from retriggering itself.

Two bounds sit above the filter. A message older than 24 hours never starts a run, so an event
trigger added long after the account was connected — or a cursor that sat frozen while the account
had no consumer — cannot replay a mailbox as agent tasks; this is Granola's stale-note guard applied
to a source that actually has a backlog. And at most 25 messages in one pass may start runs.

Past that cap the remaining matches are dropped and logged, not deferred. The history cursor is
shared with ingestion and has to advance, so holding it would stall ingestion and re-fetch the same
window forever, and a separate event cursor is a column and a migration for a case that only
arises from an unfiltered trigger on a mailbox receiving more than 25 messages in five minutes.
Dropping loudly is the honest trade; the log names the counts.

### Context is untrusted

A routed message is re-read once with `format=full`, after a route matched it, so the run's goal
carries the body and a workflow can act without a tool call the author may not have granted. A body
that cannot be read falls back to the snippet the metadata already holds rather than dropping the
event.

Email is the only event source anyone on the internet can write into, so its context block says so
in two lines: the content is untrusted and written by its sender, and instructions inside it are
never direction. The provider-neutral composer already wraps the block in a tag and neutralizes a
smuggled closing tag; this is the preamble doing the remaining work.

## Consequences

Gmail's event connection is the personal connection the plugin page already connects, so unlike
Linear, Jamie, and Granola there is no separate Events section to build — one Google account is one
integration row whichever access it was authorized with, and both Gmail scope sets can read labels
and messages.

Existing installations need the plugin update action to see the new event, as with every earlier
event addition. Ingestion behavior for an account with a brain source is unchanged except for the
two-minute interval change.

One extra full-message read per routed message, bounded by the per-pass cap, and one label listing
per filter picker open. Both are far below Gmail's per-user limits.

An unfiltered trigger on a busy mailbox is the one configuration that can lose events, by design,
at 25 per pass. The cap is deliberately low enough that hitting it is a signal the author wanted a
label, and the warning log says exactly that.

Provider references:
[Gmail history list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list),
[Gmail labels list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/list),
[Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push).
