# ADR 0001: Headless Chat v1 foundation and migration boundaries

- Status: Accepted for issue [#1165](https://github.com/useopencompany/opencompany-experimental/issues/1165)
- Date: 2026-08-10
- Owners: API, web Chat, and runner maintainers
- Supersedes: none

## Context

Ordinary Chat is currently orchestrated by the Next route at
`apps/web/app/api/chat/route.ts`. That request authenticates the user, resolves tenant and Brain
context, selects the model and tools, runs the model loop, streams presentation output, applies
billing and approval behavior, and persists the result. Redis can make the foreground stream
resumable, but it is optional and is not a durable execution boundary. Closing the originating HTTP
request can therefore end ordinary Chat execution.

The existing runner already has the Postgres primitives this slice needs: queued rows, direct
`FOR UPDATE SKIP LOCKED` claims, fenced leases, heartbeats, retry counters, and abandoned-work
recovery. Its physical tables and several public routes use historical coding-chat terms. They can
remain in storage during this phase, but those names and lease details must not become the new
domain or wire contract.

Issue #1165 requires one complete vertical slice, not a repository-wide rename. Every step must be
deployable, preserve existing data and clients, and be reversible without a destructive migration.

## Decision

### Canonical model and package boundaries

The canonical terms are `Conversation`, `Message`, `Run`, `Attempt`, and `Event`:

- A `Conversation` owns ordered user and assistant `Message` records.
- Sending a user `Message` creates one stable `Run` in the same database statement.
- Each claim or retry creates a new `Attempt`; retrying never changes the `Run` ID.
- Meaningful progress is recorded as ordered semantic `Event` records. Provider events, raw model
  payloads, token-level deltas, worker IDs, leases, and database rows are not protocol DTOs.

`packages/core` owns framework-independent application services and ports. It may use plain values
and an explicit `Actor`, but it does not import Hono, Next.js, WorkOS, Drizzle, provider SDKs,
process environment, or transport types. `packages/protocol` is the single source for runtime
validation, the OpenAPI document, semantic event schemas, version metadata, and the compiled Hono
first-party client. The public contract is HTTP and SSE; Hono RPC types are a first-party compile
time convenience, not the public wire format.

The DB adapter lives in `packages/db`. The API and runner are separate composition roots over the
same core services and repository ports. The runner claims work directly through its fenced
execution repository; it does not call the public API for leases or settlement.

### Initial HTTP contract

All canonical routes are under `/v1`:

| Method | Route | Meaning |
| --- | --- | --- |
| `GET` | `/v1/conversations` | List actor-visible Conversations with an opaque page cursor. |
| `GET` | `/v1/conversations/{conversationId}` | Read Conversation metadata. |
| `GET` | `/v1/conversations/{conversationId}/messages` | Read durable Messages. |
| `POST` | `/v1/messages` | Atomically create a user Message and queued Run. |
| `GET` | `/v1/runs/{runId}` | Read authoritative Run state. |
| `GET` | `/v1/runs/{runId}/events` | Stream typed Run Events over SSE. |
| `POST` | `/v1/runs/{runId}/cancel` | Idempotently request or complete cancellation. |
| `POST` | `/v1/runs/{runId}/approvals/{approvalId}` | Resolve a durable approval/continuation. |

`POST /v1/messages` requires `Idempotency-Key`. It returns stable Conversation, Message, and Run
IDs plus the original 32-bit Postgres transaction ID as a decimal string for Electric optimistic
write confirmation. A replay with the same actor, workspace, key, and request hash returns the
original result. Reusing the key with a different normalized command is a structured
`idempotency_conflict`.

The request hash is SHA-256 over the normalized canonical command, including ordered opaque
attachment IDs. Command reservations do not expire during this phase: a delayed native retry must
not cause an old key or resource ID to acquire a new meaning. They are removed only with their
owning user or workspace. Resource IDs in the reservation deliberately do not depend on a client
parsing their format. The repository checks current workspace membership and a committed command
reservation before resolving attachment IDs, so a replay does not depend on the upload still being
available. The atomic write statement remains the arbiter for concurrent first requests.

The API returns versioned structured errors with a request ID and retryability. Resource IDs are
opaque. Protocol DTOs do not contain WorkOS IDs, physical table names, Drizzle types, provider
payloads, lease ownership, credential material, or secrets.

Message commands carry only server-minted opaque attachment IDs. Before persistence an API-side
resolver verifies Actor ownership and maps them to the existing private storage metadata and
extracted text. Message DTOs expose safe attachment metadata only (ID, filename, media type, size,
and kind), never private blob URLs/paths or a storage provider. Existing attachment bytes and
extracted text remain available to later model turns. Before the canonical path is activated, PR 2
adds an API-owned, actor/workspace-scoped upload registry and upload lifecycle. Registry metadata is
immutable, is claimed for one Message in the same transaction as that Message, and is retained for
command replay; private storage locators stay confined to the API/DB adapter.

### Authentication, identity, and tenancy

The API accepts two authentication presentations:

- Web uses the existing secure WorkOS-backed browser session.
- Native clients use a bearer access token obtained with OAuth Authorization Code + PKCE. Native
  apps are public clients: no client secret is embedded, and tokens are stored in the platform
  secure store.

Both presentations are converted at the API boundary to an explicit provider-independent `Actor`:
opaque user ID, server-resolved workspace ID, role, permissions, authentication method, and an
optional session ID. A workspace ID from a request body or query is never trusted. Authorization is
checked before invoking the application service and again in repository predicates.

During this slice, the identity adapter may set `Actor.userId` to the current WorkOS-backed user key
because existing foreign keys use it. Core and protocol code do not know that mapping. A later
additive identity migration will introduce internal user IDs, backfill provider identities, switch
the adapter, and only retire provider-key foreign keys after verification; that physical migration
is explicitly outside this phase.

### Additive persistence mapping

Postgres is authoritative. We retain current rows and map physical storage behind the repository:

| Canonical concept | Phase-one physical storage | Rule |
| --- | --- | --- |
| Conversation | `goat.chat_sessions` | Only owner-visible, open rows of kind `chat`; physical names never leave the adapter. |
| Message | `goat.chat_messages` | Existing content, attachments, extracted attachment text, task linkage, and debug projections remain intact. |
| Run | `goat.codex_chat_turns` | New ordinary Chat Runs receive `run_*` IDs; existing opaque IDs remain valid. |
| Runtime container | `goat.codex_chat_sessions` | Hidden adapter detail used by the current runner; it pins engine, model, and workspace. |
| Attempt | additive `goat.run_attempts` | One explicit immutable-numbered execution record per claim/retry, fenced by the current lease. |
| Approval | additive `goat.run_approvals` | Durable tool decisions or single-question continuations, scoped to a Run and optional Attempt. |
| Event | additive `goat.run_events` | Versioned semantic payload with a per-Run positive sequence. |
| Command replay | additive `goat.chat_command_idempotency` | Actor/workspace/key uniqueness, request hash, stable resource IDs, and original transaction ID. |

Migration `0198_goat_headless_chat_foundation.sql` only adds a non-negative `event_sequence`
counter and new tables/indexes/foreign keys. It does not rename, rewrite, or drop existing data.
The counter defaults to zero for all existing Runs. A legacy owner-only Conversation without a
runtime row is readable with current behavior; its first canonical durable write creates the hidden
runtime and pins it to the server-resolved actor workspace. The same rule applies to legacy runtime
rows whose workspace is still null. A runtime already pinned to another workspace is never adopted.
Existing Conversation model selection wins on follow-up messages.

Approval IDs are scoped by Run in the HTTP route. `run_approvals` is the canonical durable request
and typed resolution; runner compatibility code projects existing engine interactions into it and
translates the response back during migration. A second, different resolution or answer payload is
an idempotency conflict. Approval resolution and cancellation write their semantic Event in the
same statement as authoritative state.

The create-Message adapter uses one Postgres data-modifying CTE statement to reserve the command,
create or validate the Conversation, insert the user Message and assistant placeholder, upsert the
hidden runtime, insert the queued Run and first `run.queued` Event, and return the original
transaction ID. A process crash cannot expose a Message without its Run or vice versa.

### Event ordering, reconnection, and wakeups

Event cursors have the opaque form `v1:<positive-sequence>`. The sequence is scoped to one Run.
Appending a batch atomically increments the Run's `event_sequence` counter and assigns consecutive
values. This avoids a global-serial commit-order race and prevents a reconnecting client from
skipping a late transaction. A unique `(run_id, sequence)` index is the storage invariant.

SSE uses each durable cursor as `id` and accepts either `Last-Event-ID` or the equivalent cursor
query. The API authorizes the Run, reads every Event strictly after the cursor, sends them in
sequence, and then waits for more. Reconnect always performs a Postgres catch-up before waiting.
Clients also refresh the durable Run and Message state, so missing transient presentation frames
cannot lose the result or duplicate a Message.

If both cursor presentations are supplied and disagree, the API rejects the request instead of
guessing. A cursor is a protocol token, not a globally comparable database ID.

`LISTEN/NOTIFY` on the versioned `goat_run_events_v1` channel is the low-latency wake mechanism.
Notifications carry only Run ID and latest sequence, are emitted by the same transaction, and are
never authoritative. The API periodically polls/catches up, and the runner periodically claims
queued work. A lost notification adds latency but cannot lose execution or output. Redis remains an
optional legacy presentation aid during cutover and is not required by `/v1` correctness.

High-frequency model tokens are coalesced before durable `message.content_updated` Events. Durable
Events cover Run transitions, tool/approval transitions, artifact publication, final Message
references, errors, and cancellation. Raw provider streams stay out of the semantic log.

### Compatibility, rollout, and rollback

PR 1 does not change behavior or routing for existing clients:

- Next `/api/chat`, `/api/chat/{id}/stream`, and stop/interaction routes continue to own their
  current paths until the durable API is proven.
- The macOS app continues to use bearer auth and `POST /api/chat`. Its existing Authorization Code
  + PKCE flow, Keychain storage, one-time 401 refresh, and reuse of client-reserved IDs are
  compatibility requirements.
- Current Redis resume behavior remains available only to the legacy route during the transition.

PR 2 adds the independently deployable API and runner path without switching clients. A thin legacy
adapter may then translate the existing request to the canonical command/event service, but it may
not contain a second model loop. PR 3 cuts web writes and live output to `/v1`, then restricts
Electric to API-owned, actor-scoped, versioned Chat read models. PR 4 adds mobile and either moves
macOS to `/v1` or proves the thin adapter.

The implementation audit before PR 3 found several foreground-only tools (task and schedule
creation, Brain capture, skill activation, managed capabilities, browser, and wiki) that must be
composed into the runner before a default-on cutover can preserve behavior. Therefore PR 3 ships a
real but explicit cohort path rather than silently reducing capabilities:

- `NEXT_PUBLIC_GOAT_HEADLESS_CHAT=true` selects canonical ordinary-Chat create, upload, cancel,
  approval, archive, restore, pin, seen-state, SSE, and Conversation/Message/Run read-model traffic.
  It is false by default until the PR 4 parity gate. Auto model selection stays on the compatibility
  adapter until routing moves behind the canonical command service. Coding-chat metadata writes
  remain on their existing engine-specific path and are not part of the migrated ordinary-Chat
  resource.
- The browser calls same-origin `/v1`; the Next proxy uses server-only `GOAT_API_ORIGIN`, forwards
  the existing session cookie, and rejects missing, invalid, credential-bearing, or same-origin
  targets. Browser code never receives the API origin or Electric credentials.
- Electric collection URLs select only the fixed `chat-*-v1` names. The API chooses physical
  tables, columns, and actor/workspace predicates; client `table` or `where` parameters are ignored.
- `apps/web/app/api/chat/route.ts` is a thin compatibility boundary. Its foreground implementation
  is isolated in `lib/legacy-chat-route.ts` solely for a flag rollback and continues to serve
  unflagged deployments. It is not called by the canonical path and must not gain new behavior.

Moving the default-on cohort gate from PR 3 to PR 4 is an evidence-driven boundary adjustment, not
a new product scope: it keeps PR 3 independently deployable while the runner parity work remains in
the rollout PR. Production configuration is not changed by these code PRs.

The compatibility adapter can be removed only after web, mobile, and macOS canonical-path checks
pass in CI and the agreed production soak has no unexplained command, Run settlement, reconnect, or
tenant-isolation regressions. That removal is a separate reversible change. It requires
`@louismorgner` review if it changes native or mobile interaction behavior.

Foreground requests already executing on the legacy path are allowed to finish there. We do not
manufacture canonical Event history for work that began outside the durable queue. Client cutover
begins only after the canonical API and worker parity gates pass.

Deployment order is migration, runner, API, compatibility adapter, then clients. Rollback reverses
clients and API/runner code while leaving the additive tables and counter in place. Old code ignores
them. No rollback drops data. Production infrastructure, deployments, OAuth configuration, and
secrets are changed only through separately authorized operational work.

## Characterized behavior and verification gates

The pre-change audit established these preservation gates:

- `apps/web/app/api/chat/route.test.ts`: session/bearer auth, tenant resolution, engine/model
  mentions, tools and Brain context, billing limits, approvals, task creation, partial and error
  outcomes, and foreground streaming behavior.
- `apps/web/lib/chat.test.ts`: Conversation ownership and lifecycle, stored model reuse,
  attachments plus extracted attachment text, assistant/task/debug persistence, approval
  continuations, cancellation projections, and stale tool-call settlement.
- `apps/web/app/api/chat/[chatId]/stream/route.test.ts`, stop tests, and
  `apps/web/lib/chat-streams.test.ts`: current resume, stop, and Redis-optional behavior.
- `apps/web/lib/chat-request-auth.test.ts`: browser session and WorkOS bearer-token resolution.
- `apps/web/app/api/electric/v1/shape/route.test.ts`: current Electric authorization. PR 3 must
  replace physical-table selection for migrated Chat reads with versioned read models.
- `apps/runner/src/goat-codex-chat-worker.test.ts` and related runner tests: claim fencing,
  heartbeat/retry, attachment and billing behavior, partial results, wakeups, and abandoned-work
  recovery.
- `apps/goat-macos/GoatQuickTests`: PKCE/state, callback parsing, bearer request shape, secure-token
  flow, one 401 retry, and stable identifiers. These tests require Xcode and cannot run in the Linux
  sandbox; CI or a macOS reviewer must run them before native cutover.
- `packages/core`, `packages/protocol`, and `packages/db` tests: provider-independent Actor and
  application rules, strict/versioned DTOs and Events, generated OpenAPI currency, additive
  migration preservation, tenant isolation, atomic idempotency, explicit Attempts, lease fencing,
  and gap-free cursor allocation.

Each cutover PR must run the affected characterization set in addition to its new contract,
repository, API, recovery, reconnect, and client tests. Deliberate behavior changes require a
separate approved decision; absence of a regression test is not approval.

## Consequences

This design reuses proven Postgres durability and leaves physical cleanup for later. It introduces
a temporary vocabulary translation in the DB adapter and a temporary compatibility route, but
both have explicit boundaries and removal conditions. Per-Run cursors make one stream simple and
safe; aggregating Events across Runs would need a different cursor and is not promised in v1.

The four independently deployable PRs from issue #1165 remain intact. PR 1 contained a real atomic
repository and worker execution port rather than empty package scaffolding. The verified
foreground-only capability gap moved only the default-on cohort gate—not the web implementation—
from PR 3 to PR 4. This ADR and the issue record that evidence before rollout begins.

## Alternatives rejected

- New parallel Conversation/Message/Run tables plus a full backfill would create two authorities,
  make rollback harder, and force destructive reconciliation.
- Renaming the current durable tables or `apps/runner` would spend data and deployment risk on
  appearance; the adapter is the vocabulary boundary.
- A global serial Event cursor can be allocated out of commit order and let a reconnecting consumer
  skip a late lower ID.
- `LISTEN/NOTIFY` or Redis cannot be the replay store because neither is an authoritative durable
  log.
- Redis, Kafka, Temporal, or another queue would duplicate the lease/recovery system already proven
  in Postgres.
- Client-selected workspace IDs create a confused-deputy tenancy boundary.
- Provider blob URLs and paths are not a stable or safe attachment protocol.
- Cutting web and native clients over in this PR would couple contract, execution, read projection,
  and UX rollback into one unsafe release.
