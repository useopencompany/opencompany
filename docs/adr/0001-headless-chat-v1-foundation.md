# ADR 0001: Headless Chat v1 foundation

- Status: Accepted and fully cut over
- Date: 2026-08-10
- Final cutover: 2026-08-13, issue [#1203](https://github.com/useopencompany/opencompany-experimental/issues/1203)
- Owners: API, web Chat, and runner maintainers

## Context

Chat originally ran inside the Next.js composition root. That coupled browser presentation,
authentication, durable execution, provider orchestration, billing, approvals, and persistence to
one foreground HTTP request. Closing the request could end work, and web code owned database writes
that native clients could not reuse.

The canonical system needed one authenticated protocol and one durable execution model for
OpenCompany, Codex, and Claude Code while preserving existing data and exactly-once behavior.

## Decision

The canonical terms are `Conversation`, `Message`, `Run`, `Attempt`, and `Event`:

- A Conversation owns ordered user and assistant Messages.
- Sending a user Message creates one stable Run atomically.
- Each claim or retry creates an Attempt; retrying never changes the Run ID.
- Ordered semantic Events describe progress. Provider payloads, lease details, and physical rows do
  not cross the protocol boundary.

`packages/core` owns framework-independent application services and ports. `packages/protocol`
owns runtime validation, OpenAPI, event schemas, version metadata, and the first-party typed client.
`packages/db` owns Postgres mapping. `apps/api` and `apps/runner` are separate composition roots over
those shared packages; the runner claims work directly from Postgres.

### HTTP contract

All Chat commands and reads are authenticated `/v1` routes:

| Method | Route | Meaning |
| --- | --- | --- |
| `GET` | `/v1/conversations` | List actor-visible Conversations. |
| `GET` | `/v1/conversations/{conversationId}` | Read Conversation metadata. |
| `PATCH` | `/v1/conversations/{conversationId}` | Archive, reopen, pin, or mark seen. |
| `GET` | `/v1/conversations/{conversationId}/messages` | Read durable Messages. |
| `POST` | `/v1/messages` | Atomically create a Message and queued Run. |
| `GET` | `/v1/runs/{runId}` | Read authoritative Run state. |
| `GET` | `/v1/runs/{runId}/events` | Stream typed semantic Events over SSE. |
| `POST` | `/v1/runs/{runId}/cancel` | Idempotently request cancellation. |
| `POST` | `/v1/runs/{runId}/approvals/{approvalId}` | Resolve a durable approval or question. |

Message creation requires `Idempotency-Key`. A replay with the same actor, workspace, key, and
normalized request hash returns the original Conversation, Message, and Run. Reusing the key with a
different command returns `idempotency_conflict`. Reservations do not expire and resource IDs are
opaque.

Attachment commands accept only server-minted opaque IDs. DTOs expose filename, media type, size,
and kind, never private storage locators, credentials, WorkOS IDs, physical table names, or provider
secrets.

### Authentication and tenancy

Every `/v1` route resolves an Actor from a WorkOS browser session or bearer token and rechecks
workspace membership at the command or read boundary. Cookie-authenticated mutations require an
allowed browser `Origin`; credentialed CORS is restricted to configured first-party origins.

Runner capabilities are short-lived, scoped to a Run and Attempt, and revalidated against persisted
membership and live lease authority. Sandboxes never receive workspace identifiers, provider
credentials, or internal service tokens.

### Execution and presentation

Postgres is the durable authority and queue. Fenced leases, heartbeats, retry counters, and
abandoned-work recovery keep one authoritative Attempt active. Redis is an optional presentation
replay lane, not a correctness dependency. API-owned Electric read models project Conversation,
Message, Run, approval, artifact, Task, Workflow, and knowledge state to the web client.

The browser uses the typed client for create, follow-up, cancellation, approvals, runtime access,
attachments, and Conversation updates. Engine settings are versioned Message descriptors. Codex
and Claude Code keep durable engine-session continuity without engine-specific browser routes.

## Final cutover

Issue #1203 closed the rollback window after the owner completed the production pass. The web-owned
compatibility transport, bespoke engine endpoints, direct Chat database writers, and unused
physical Electric Chat selectors were deleted. Operating mode is fix-forward through the canonical
API, runner, and read models.

The 35 known sessionless historical Tasks and their actor-scoped, read-only compatibility resources
remain protected by [ADR 0002](./0002-headless-task-v1-foundation.md). They are not part of this
Chat deletion.

## Consequences

- The API/runner path is the only supported Chat execution path.
- Every new client uses the public protocol rather than importing server implementation details.
- Releases must keep API and runner configuration valid; there is no presentation rollout switch.
- Database evolution remains additive. Operational recovery deploys a forward fix and allows
  already accepted Runs to settle under their original idempotency semantics.
