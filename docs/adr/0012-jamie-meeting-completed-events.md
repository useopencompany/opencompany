# ADR 0012: Jamie Meeting-Completed Events

- Status: Accepted
- Date: 2026-09-13
- Extends: [ADR 0009](./0009-poll-delivered-plugin-events.md)

## Context

Linear and Granola cover the two delivery modes ADR 0009 defined, but between them they also fixed
a shape the platform has not had to question: the event connection is a credential opencompany
obtains itself, through an OAuth app it owns or an API key it can validate on paste.

Jamie fits neither. Its plugin connects over MCP OAuth, which has no subscription primitive. Its
REST API needs a Pro, Team, or Enterprise plan and there is no Jamie connection for it today, so a
Granola-style poller would mean a new credential, a new sync-state table, and a higher plan floor
than the feature deserves. Its webhooks need only Plus, carry the whole finished meeting — summary,
transcript, extracted action items, participants, calendar attendees — and fire the moment Jamie
finishes processing. What they do not have is a management API: the endpoint is created by hand in
Jamie's own settings, and Jamie mints the key there and shows it once.

## Decision

The Jamie package declares one `webhook` event, `meeting.completed`, matching Jamie's own event
name. The platform publishes one fixed ingress, `/api/webhooks/jamie/events`, that every Jamie
webhook can point at, and the connection is made by pasting the key Jamie minted into the plugin's
Events section.

That key is the connection's identity. opencompany stores only its SHA-256 digest, as the
integration row's `external_id`, and a delivery is bound to a connection by looking its presented
key up as a digest. Nothing recoverable is kept, so a database disclosure cannot forge a delivery,
and an exact match on a digest is the whole credential check — a hash lookup tells an attacker
nothing about a near-miss key. Jamie's own recommendation is API-key authentication; its HMAC
alternative would instead require storing a replayable secret and a per-connection URL, and the
same key compromise forges deliveries either way.

Jamie cannot validate a key on save, so the save is trusted and every verified delivery stamps
`last_synced_at`. The Events section reports that timestamp, which is the only honest confirmation
that a pasted key works, and points at Jamie's Test button for getting one immediately.

Because a Jamie payload carries no meeting id — only a per-delivery id whose stability across retry
attempts is undocumented — the delivery key is derived from the meeting's own identity: a digest of
the recording user, start time, and title. That is stable by construction across Jamie's five retry
attempts, and collides only for one person's same-titled meeting starting at the same instant,
which is the same meeting. Re-processed notes therefore do not start a second run.

The package declares one optional `choice` filter, `guests`, evaluated against the delivery:
`external` when anyone on the calendar event or in the transcript has an email outside the
recording user's domain, `internal` when nobody does. When the payload never names the recording
user's domain the scope is null and neither choice matches, so a filtered workflow does not run —
a filter the platform cannot evaluate must not guess.

Jamie's personal integration rows split the way Linear's, HubSpot's, and Attio's already do: the
MCP connector row is the plugin's tool connection, and the event connection is the personal account
a workflow trigger binds to.

## Consequences

Adding a webhook-backed event no longer requires an opencompany-owned OAuth app. A provider whose
users can create their own endpoint needs one public path, a digest column, and an ingress adapter
— which is a materially smaller commitment than either alternative was for Jamie.

Setup is manual and two-sided: copy a URL out of opencompany, create the webhook in Jamie, bring
the key back. That is one paste more than Granola's and it cannot be verified until Jamie sends
something, which is why the last-delivery timestamp is part of the feature rather than a nicety.

The `guests` filter is decided by the payload, not by anything the user maintains, so it works
from the first meeting. Tags would have been the other candidate and were left out: they are
usually applied after a meeting ends, so a tag filter would silently fail to fire, and listing them
needs the REST API this connection deliberately avoids.

No poll cursor exists, so there is no backlog to replay and no stale-event age guard: Jamie pushes
live and retries for about an hour. A connection that was down longer than that misses those
meetings rather than starting a burst of agent tasks later.

Provider references: [Jamie webhooks](https://docs.meetjamie.ai/developers/webhooks/getting-started),
[Jamie webhook delivery and retries](https://docs.meetjamie.ai/developers/webhooks/delivery-retries).
