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

The web presentation is the rollout target for this phase. Bearer/PKCE remains a supported protocol
and authentication seam for the later native project; no Expo or macOS-native client work is a
phase gate after the issue owner's 2026-08-11 scope decision.

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

### Transient presentation lane

Client testing after PR #1172 measured canonical visible updates at approximately 223–308 ms even
with a 150 ms durable projection throttle. The two sequential Postgres writes in that path are the
measured bottleneck, while the legacy foreground stream presents provider output on approximately a
50 ms cadence. This justifies the optional Redis hot-replay layer anticipated by the reference
architecture without changing Postgres authority.

The runner publishes append-only `message.presentation_delta` frames at no more than a 50 ms
cadence and persists complete Message snapshots plus semantic Events on a 500 ms durability
cadence. Each Redis Stream is scoped to one Run, capped at 1,024 entries, and expires five minutes
after its most recent frame. It is not a queue, durable Event store, or general event bus. Publishing
is best-effort and cannot apply backpressure to model execution or durable settlement.

Presentation frames carry the Run ID, assistant Message ID, current Attempt number, append offset,
delta, and a separate opaque `p1:` cursor. They are validated protocol events but are not durable Run
Events. SSE therefore omits the `id` field for presentation frames. Only durable `v1:` cursors are
written as SSE IDs, remain valid in `Last-Event-ID`, and define reconnect correctness.

A client may additionally send its last `presentationCursor` query value. Every connection first
catches up durable Events from Postgres, then reads Redis frames after that transient cursor (or the
bounded hot window when no transient cursor exists). The client applies a delta only where its
offset meets the current Message snapshot and ignores already-applied ranges. If trimming or expiry
creates a gap, it stops applying transient deltas until a durable Message snapshot reaches the gap;
it never guesses or duplicates content. An invalid transient cursor is rejected, but an unavailable
or failed Redis read silently falls back to the existing Postgres loop.

Attempt numbers fence presentation after recovery: the API accepts only frames matching the Run's
authoritative current Attempt count, so a delayed old worker cannot overwrite recovered output.
Multiple API instances read the same bounded stream independently without consumer groups. Slow
consumers may lose animation frames when the length cap advances, then recover from Postgres.

Before every `run.paused`, `run.completed`, `run.failed`, or `run.canceled` Event, the runner writes
the latest complete assistant Message and appends a final durable
`message.content_updated(complete=true)` Event. The terminal Event follows it in the same ordered
durable sequence (and in the same settlement batch except at the approval pause boundary). Redis
failure, expiry, process restart, or total absence can therefore reduce
smoothness only; it cannot lose, corrupt, duplicate, or prevent work.

### Compatibility, rollout, and rollback

#### Phase 2 execution-capability inventory and transport decision

Issue [#1185](https://github.com/useopencompany/opencompany-experimental/issues/1185) re-audited
the live runner and sandbox call graph before extraction. The inventory below is the deletion gate;
route names alone are not evidence that a transport is unused.

| Audited transport | Authoritative callers on 2026-08-11 | Shared owner / cutover | Final result |
| --- | --- | --- | --- |
| `POST /api/internal/action-gateway` | OpenCompany and Codex runner adapters | action application service in `packages/goat-agent`, composed in-process by runner | removed from web after the repeated caller audit |
| `POST /api/internal/codex-actions` | no direct current caller; compatibility alias only | same action service | removed with the action adapter |
| `POST /api/internal/codex-brain-capture` | OpenCompany and Codex runner adapters | Brain capture application service plus existing DB/Brain adapters | removed from web after in-process cutover |
| `POST /api/internal/headless-chat-tools` | OpenCompany runner host-tool adapter | shared host-tool application service over Task, Workflow, schedule, skill, wiki, browser, and Brain ports | removed from web after in-process cutover |
| `/api/internal/claude-actions` streamable HTTP MCP | Claude CLI inside the E2B sandbox | runner-hosted MCP transport over the same action and artifact services | removed from web after v2 ticket/tenant/lease tests and production runner health |
| `POST /api/chat/model-route` | canonical web Chat transport before `POST /v1/messages` | canonical API Message/Run creation and the shared Auto-routing provider adapter | removed after API-owned routing and stored-model replay cutover |
| `POST /api/internal/opencompany-chat/messages` | no code caller; documentation and route tests only | none | removed after the repeated audit again found no caller |
| `POST /internal/goat/chat-artifacts/publish` on runner | web-hosted Claude MCP adapter | runner-owned artifact application service | removed; runner-hosted MCP invokes publication in-process |

`GOAT_NEXT_PUBLIC_APP_URL` remains the canonical web origin for OAuth callbacks and other web
presentation responsibilities. Phase 2 removes it only from runner capability enablement and
execution; it is not a global environment-variable deletion.

The repeated final audit retains `/api/chat` and `apps/web/lib/legacy-chat-route.ts` unchanged for
macOS compatibility, plus web-to-runner wake, sandbox status/termination, auth brokerage,
dictation, coding-workspace runtime access, Brain ingestion/import, Google Drive sync, and harness
planning transports. Those are presentation/setup or worker-control responsibilities, not
runner-to-web execution dependencies. Public web MCP, integration callbacks/webhooks, settings,
Slack, and billing reconciliation continue to call the shared package implementations in-process.

The Claude sandbox MCP transport will move to `apps/runner`, not `apps/api`. Current deployment
evidence shows `opencompany-runner` is already a public Render web service, release preflight
requires `RUNNER_PUBLIC_URL`, and the runner already serves narrow ticketed sandbox/browser
transports and owns artifact publication. Hosting the MCP endpoint there keeps action and artifact
execution in the same composition root and does not add API availability to an already-queued Run.
The sandbox receives only a short-lived turn capability and the runner public endpoint; every tool
call re-derives the session, Run/turn, membership, engine, contract version, and running/lease
authority from Postgres. The capability contains no user/workspace identifier, provider
credential, or `RUNNER_INTERNAL_TOKEN`.

The extraction PR changed ownership only: its web routes continued to compose the shared services
and all runner/sandbox URLs remained unchanged. The direct-runner and sandbox cutovers were
separate rollback boundaries, followed by a fourth independently green route-deletion change.
Integration and managed-capability catalogs/execution, Brain capture/copy rules, skills, workflows,
wiki operations, browser-profile persistence/provider code, Claude tool registration, and Auto
routing now live under their existing shared package owners. Stripe auto-refill remains the same
idempotent off-session flow but is owned by `packages/billing`; web compatibility modules only
re-export or adapt these shared implementations for callers outside canonical Chat.

The direct-runner PR removed normal runner calls to the action, Brain-capture, and host-tool web
routes. The runner now composes the same persisted services in-process, including durable action
governance, attachment copy and Brain quota semantics, task worker wakeups, schedule planning,
workflow/skill resolution, wiki access, browser-profile cleanup, and browser sandbox execution.
Tests force the web-origin network lane unavailable while these adapters execute. The routes stayed
as rollback adapters until the later Claude and Auto cutovers were deployed.

The sandbox/canonical cutover PR moves Claude's MCP URL to the runner's public
`/internal/goat/claude-actions` endpoint. New v2 HMAC capabilities contain only opaque session,
Run, Attempt, lease, and expiry claims. They contain no Actor or workspace identity and grant no
access to bearer-protected runner routes. The runner joins persisted session, turn, Attempt, and
membership state before request admission and again before each tool operation; exact lease ID,
worker ownership, lease expiry, active-turn state, contract version, engine, cancellation, and
membership must still match. The runner endpoint accepts v2 only; the temporary web MCP rollback
adapter was removed after the cutover deployment advertised v2 health.

The same PR makes `POST /v1/messages` the canonical Auto-routing boundary. The API derives Actor
and workspace from authentication, checks current membership and the persisted feature flag, and
resolves `model: "auto"` before Message/Run creation. An already accepted idempotency key reuses its
Conversation model even if the response was lost; an existing authorized Conversation also reuses
its stored model. Only a new command without stored state validates attachment ownership/expiry and
calls the provider. The accepted response may include the resolved concrete model for client
metadata. The browser no longer calls `/api/chat/model-route`, and that web route was removed after
the cutover deployment.

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
Electric to API-owned, actor-scoped, versioned Chat read models. By owner direction, PR 4 completes
web runner parity, operability, observability, and rollout evidence. Expo/mobile and macOS-native
implementation/tests move to a separate project; the existing macOS route remains unchanged.

The implementation audit before PR 3 found several foreground-only tools (task and schedule
creation, Brain capture, skill activation, managed capabilities, browser, and wiki) that must be
composed into the runner before a default-on cutover can preserve behavior. Therefore PR 3 ships a
real but explicit cohort path rather than silently reducing capabilities:

- `NEXT_PUBLIC_GOAT_HEADLESS_CHAT=true` selects canonical ordinary-Chat create, upload, cancel,
  approval, archive, restore, pin, seen-state, SSE, and Conversation/Message/Run read-model traffic.
  It remains false by default until both the PR 4 parity gate and the separately authorized API
  service rollout gate pass. That phase initially put Auto selection behind an authenticated web
  preflight; issue #1185 supersedes it with API-owned command-time resolution. Coding-chat metadata writes remain
  on their existing engine-specific path and are not part of the migrated ordinary-Chat resource.
- The browser calls `/v1` directly on the first-party `NEXT_PUBLIC_GOAT_API_ORIGIN`. Production uses
  `https://api.opencompany.chat`, which terminates TLS on the separately deployed Render API and
  removes Vercel from SSE and Electric long-poll response paths. Browser requests include the
  secure WorkOS session cookie shared across `opencompany.chat`; the API permits credentialed CORS
  only from the configured web origins and requires an allowed `Origin` on cookie-authenticated
  mutations. The API hostname is not a security boundary: authentication, server-derived tenancy,
  and repository predicates remain authoritative. When no public origin is configured (including
  local development), the client retains same-origin `/v1` as a fallback.
- Electric collection URLs select only the fixed `chat-*-v1` names. The API chooses physical
  tables, columns, and actor/workspace predicates; client `table` or `where` parameters are ignored.
- `apps/web/app/api/chat/route.ts` is a thin compatibility boundary. Its foreground implementation
  is isolated in `lib/legacy-chat-route.ts` solely for a flag rollback and continues to serve
  unflagged deployments. It is not called by the canonical path and must not gain new behavior.

PR 4 composes web-owned interactive action governance, managed approvals, default-Brain capture
(including chat attachments), task/schedule/workflow/skill/wiki behavior, public browser tools, and
reattachable authenticated browser-profile sessions into durable runner execution through bounded,
internal bearer-protected host gateways. Those gateways re-derive identity, membership, engine,
host-contract version, and running-turn state from Postgres. They are compatibility adapters for
web-owned product capabilities, not a second Chat execution loop.

Moving the default-on cohort gate out of PR 3 was an evidence-driven boundary adjustment. The PR 4
audit then found a separate operational gate: production has no deployed `apps/api` service,
`GOAT_API_ORIGIN`, or Chat cohort setting in the existing release topology. The issue explicitly
forbids changing production infrastructure or secrets without authorization. Source therefore
continues to require `NEXT_PUBLIC_GOAT_HEADLESS_CHAT=true`; enabling after the API service is
authorized is a configuration-only rollout, and removal/false is the immediate rollback. The
operational steps are recorded in `docs/headless-chat-operations.md`.

Production activation initially kept browser requests same-origin through a Next.js streaming
relay and then a native Vercel external rewrite. Controlled direct API checks and two completed
production Runs established that Render accepted the authenticated event streams while Vercel
returned HTTP 502 for the corresponding browser-facing requests. Short proxied responses worked,
but SSE and Electric long-poll responses did not. The direct first-party API origin above replaces
that topology without changing the `/v1` wire contract, durable event cursors, transient
presentation cursors, or Postgres recovery semantics. Disabling
`NEXT_PUBLIC_GOAT_HEADLESS_CHAT` remains the immediate rollback to legacy Chat; DNS and the API
service are additive and need not be removed during rollback.

The compatibility adapter cannot be removed in this web-only phase because surviving native clients
remain a later project. Removal requires that later project's migration/compatibility decision plus
an agreed web production soak with no unexplained command, Run settlement, reconnect, recovery, or
tenant-isolation regressions. Any native UX change still requires `@louismorgner` review.

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
- Native test suites are deliberately not a gate for this owner-scoped web phase. The macOS project
  remains untouched on its existing compatibility path; its migration and native evidence belong to
  the later native project.
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
foreground-only capability gap moved runner parity into PR 4 without changing the web protocol.
Owner direction then narrowed PR 4 client evidence to web and deferred native work. The production
API service remains an explicitly authorized operational gate, so mergeable code does not silently
enable a nonexistent topology.

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
- Coupling web and native cutover would combine independent execution, deployment, and UX rollback
  risks; native proof now belongs to its own owner-reviewed project.
