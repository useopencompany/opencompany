# ADR 0014: Convex Function-Failure Events

- Status: Accepted
- Date: 2026-09-14
- Extends: [ADR 0012](./0012-jamie-meeting-completed-events.md)

## Context

Every event the platform routes so far describes something a person did: an issue was filed, a
meeting finished, a note was written. They arrive at human rates, each one is its own incident, and
the provider hands over a finished object.

"Start a workflow when my Convex backend breaks" is none of those things, and it is the ask that
made us look at whether Convex emits anything at all. It does. Convex has **log streams**: a
per-deployment sink that receives every function execution, every `console` line, deployment audit
events, and periodic usage statistics. One of its destinations is a plain webhook, signed
HMAC-SHA256 over the raw body with a secret Convex mints when the stream is created. Within
`function_execution` events, `status: "failure"` plus `error_message` is the highest-signal error a
Convex-backed team has: it carries the function path and type, the request id, the run reason, the
stack, and the write-conflict or scheduler context that explains why the call ran at all.

Three things about it do not fit the existing shape.

The first is volume. A log stream is a firehose, not a doorbell. A query that throws reruns on every
subscription invalidation, so a single bug fails hundreds of times a second, batched into arrays of
events. One task per event would be a denial-of-service against the user's own workspace.

The second is that Convex, unlike Jamie, has a management API for this. `create_log_stream` on the
[Convex deployment API](https://docs.convex.dev/deployment-api/create-log-stream) accepts a deploy
key — the same credential the Convex plugin already stores — and returns the signing secret. The
two-sided copy-paste ADR 0012 accepted as the price of a webhook event is avoidable here.

The third is that a log stream costs its owner money. Convex bills log stream egress, so what
opencompany subscribes to is a bill it is writing on someone else's account.

## Decision

The Convex package declares one `webhook` event, `function.failed`, with one optional `choice`
filter, `function_type`, whose option ids are Convex's own (`query`, `mutation`, `action`,
`http_action`) so the delivery's value passes through unmapped.

**Provisioning is one button.** Turning error events on loads the deploy key already stored for the
Convex plugin, creates a webhook log stream pointed at this connection's own ingress URL, and stores
the `hmacSecret` Convex returns. Turning it off deletes the stream in Convex before removing the
row, because a forgotten stream keeps POSTing to an endpoint that can only answer 401 and keeps
billing its owner for the privilege. Re-running setup adopts a stream already pointed here and
rotates its secret rather than tripping Convex's one-webhook-stream-per-deployment rule against
opencompany's own stream; a stream pointed somewhere else is reported, never replaced.

The stream subscribes to `verification` and `function_execution` only. Every other topic would be
paid for on delivery and discarded on arrival. `exception` appears in the deployment API's topic
enum but not in the published log-event schema — it is what the Sentry and PostHog sinks consume —
so subscribing to it would mean parsing a shape Convex has not committed to. `console` at
`log_level: "ERROR"` is a real and different signal, since a handler that catches an error and logs
it never produces a failed execution; it is also the noisier half, and it is the obvious next event
rather than part of this one.

**Repeat failures are grouped.** The delivery id is a digest of the deployment, function type,
function path, and a normalized error signature, suffixed with a 15-minute window derived from the
failure's own timestamp. The existing unique `(workflow, provider, delivery)` index then does the
rest: the first failure in a window enqueues, every other one is a no-op, and a redelivered batch
computes the same ids and enqueues nothing. The signature is the first line of `error_message` with
long tokens and numbers masked, so the same bug carrying different document ids groups as one
incident. The goal says how many failures the delivery carried, which is the honest number —
grouping across deliveries would need state this design deliberately does not keep.

Two consequences of keeping it stateless are accepted rather than hidden. Failures either side of a
window boundary start two runs, which bounds duplication at one extra run per window. And the number
of distinct groups one delivery may enqueue is capped at 20, ranked by failure count, so a
catastrophic batch cannot turn into unbounded durable writes; the loudest failures are the ones that
survive.

Convex delivers best-effort and documents that retries can duplicate an event, so the signature is
the whole credential check and the grouping absorbs the duplicates. Replay protection is the age
guard rather than a timestamp header: a delivery whose failures are more than 15 minutes old is
acknowledged and recorded but routes nothing. That covers both a captured signed body replayed later
and a stream that resumed after an outage, and it matches ADR 0009's rule that a backlog is ingested,
never replayed as one agent task per historical item.

Convex's personal integration rows split the way Linear's, HubSpot's, Attio's, and Jamie's already
do: the deploy-key connector row is the plugin's tool connection, and the log-stream row is the
personal account a workflow trigger binds to. `personalAccounts.convex` therefore holds the event
row, and the plugin settings card reads the tool connection from provider state — the same move ADR
0012 made for Jamie, applied to the one provider that was still routing both rows into the same
bucket.

## Consequences

An event-backed provider no longer implies a setup the user performs on both sides. Where a provider
can create its own subscription from a credential opencompany already holds, the connection is a
button, and the failure modes it cannot hide — a plan requirement, a missing key permission, a slot
already taken — become specific error messages instead of instructions.

The deploy key is now load-bearing for two things. A key minted for the plugin's original guidance
has function and data read permissions but not `deployment:integrations:write`, so turning error
events on fails with Convex's own refusal and a request to re-mint. That is a real extra step for
existing connections, and it is preferable to asking for a broader permission during a setup that
does not need it.

Deleting the stream on disconnect means disconnecting can fail: if the deploy key is gone,
opencompany cannot stop the stream and says so rather than orphaning it. Removing the row first
would be quieter and would leave the user paying for deliveries nobody accepts.

Grouping makes the event a trigger rather than a metric. A workflow bound to `function.failed`
learns that a function started failing, not how often it fails; the failure count in the goal covers
one delivery. Anything wanting a rate belongs in a real observability sink, which is what Convex's
Axiom, Datadog, and PostHog destinations exist for.

Log stream egress is billed to the deployment's owner, and subscribing to `function_execution` means
every execution crosses the wire, not only the failed ones. Convex offers no server-side status
filter, so the topic subscription is the only lever, and the settings UI and provider guide say
plainly what opencompany subscribes to. For a busy production deployment that cost is real; for the
2–10 person teams this is built for it is small, and it is the price of the only error signal Convex
pushes.

Provider references:
[Convex log streams](https://docs.convex.dev/production/integrations/log-streams/),
[Convex deployment API](https://docs.convex.dev/deployment-api/convex-deployment-api),
[Convex role actions](https://docs.convex.dev/team-management/role-actions).
