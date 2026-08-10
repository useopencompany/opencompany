# OpenCompany Headless Core Architecture

Status: decisions made (2026-08-10), reference architecture for foundation refactor

Initial client scope: web and mobile. macOS, CLI, MCP, and third-party clients should be able to
adopt the same protocol later without changing the core.

Related work:

- [Refactor phase 1: retire the legacy product generation](https://github.com/useopencompany/opencompany-experimental/issues/1156)
- [Closed foundation-refactor prototype](https://github.com/useopencompany/opencompany-experimental/pull/1123)

## Executive Summary

OpenCompany should be a conversation-centered product where Chats, Tasks, and Workflows create
durable Runs. A versioned Hono HTTP API is the canonical client boundary, Postgres is authoritative,
a separate worker executes Runs, Electric accelerates web reads, and Server-Sent Events carry live
Run events.

The architecture in one sentence:

```text
API-first externally, application-service-first internally, Postgres-authoritative,
worker-isolated, and Electric-accelerated.
```

The decisions that matter most:

1. The client-facing product contract is versioned HTTP plus versioned stream events. Hono RPC is
   the first-party TypeScript client, not the wire protocol itself.
2. Every client write goes through the API. Clients never access Postgres, Drizzle rows, or
   arbitrary Electric shapes.
3. The API and worker are trusted backend composition roots. Both may use Postgres through shared
   repositories; the worker does not call the public API for leases, heartbeats, or settlement.
4. Every agent execution is a durable Run, whether started by chat, task, workflow, schedule,
   webhook, or delegation.
5. RSC streams web presentation. SSE streams product runtime events. Electric synchronizes
   authorized read models. These are complementary layers, not competing architectures.
6. Postgres stores meaningful product history. Redis is an optional transient replay and fan-out
   optimization, not a source of truth and not a baseline dependency.
7. Start with one modular core package and a small number of real deployables. Do not turn each
   domain folder or provider into a package.

## Why This Exists

The current product already contains most of the right primitives:

- Postgres-backed durable work with leases and recovery.
- A current Next.js product surface and a long-lived runner.
- Shared agent, Brain, database, and observability packages.
- Electric and TanStack DB for live web data.
- Normalized runtime events for cloud coding engines.
- Strong tests around chat, tasks, workflows, integrations, Brain ingestion, and billing.

The problem is not a missing technology. It is that product generations, product concepts, UI
transport, business logic, database access, and execution infrastructure have accumulated inside
the same app and runner boundaries.

This refactor should make the existing good primitives legible. It should not replace them all at
once or introduce infrastructure without a demonstrated product need.

The current [`Agent turn vocabulary`](../agent-turn-vocabulary.md) remains the description of the
legacy runner while migration is in progress. This page defines the target vocabulary: durable
`Run` and `Attempt` records supersede `turn` as persistence and execution concepts.

## Product Surface

The primary product surfaces are:

1. **Chat** — an ongoing conversation with OpenCompany.
2. **Tasks** — tracked work with a goal, status, conversation, and outcome.
3. **Workflows** — reusable definitions or triggers that create Tasks and sequence work.
4. **Brain** — durable workspace knowledge.
5. **Integrations** — connected external accounts and systems.
6. **Settings** — identity, workspace, preferences, usage, billing, and controls.

Home, navigation, onboarding, and search are product experiences over these concepts, not separate
domains. Runs, Attempts, Events, Engines, and Workers are runtime concepts and should not become
top-level navigation.

### Chat And Task Are Not Parallel Messaging Systems

A Chat is the user-facing presentation of a Conversation. A Task adds tracking and outcome metadata
to a Conversation.

```text
Ordinary Chat
  = Conversation

Task
  = Conversation
  + goal
  + status
  + optional workflow/trigger
  + outcome and artifacts
```

There should not be independent chat-message, task-message, workflow-message, and coding-message
models. All of these should converge on one Conversation and Message contract, with product-specific
metadata layered around it.

## Canonical Vocabulary

### User-Facing Concepts

| Term | Meaning |
|---|---|
| **Workspace** | The tenancy and collaboration boundary for a company or team. |
| **Chat** | An ongoing user-facing conversation with OpenCompany. |
| **Task** | A tracked piece of work with a goal, status, Conversation, and outcome. |
| **Workflow** | A reusable definition or trigger that creates a Task and sequences Runs. |
| **Brain** | Durable workspace knowledge and evidence. |
| **Integration** | A connected external account or system. |
| **Artifact** | A durable file or output produced during work. |

Users should rarely need to understand Runs, Attempts, Events, Engines, or Workers.

### Core And Runtime Concepts

| Term | Meaning |
|---|---|
| **Conversation** | The ordered container of Messages underlying a Chat or Task. |
| **Message** | Durable user, assistant, or system content in a Conversation. |
| **Run** | One durable unit of agent execution caused by a Message, workflow step, schedule, webhook, or delegated request. |
| **Attempt** | One Worker's attempt to execute a Run. Retries create Attempts without changing Run identity. |
| **Event** | An ordered observable change emitted by a Run. |
| **Engine** | The execution implementation, initially OpenCompany, Codex, or Claude Code. |
| **Engine session** | Provider or sandbox continuity required by an Engine across Runs. |
| **Worker** | An infrastructure process that claims and executes Run Attempts. |

### Relationships

```text
Workspace
  ├── Conversations
  │     ├── Messages
  │     └── Runs
  ├── Tasks
  ├── Workflows
  ├── Brain
  └── Integrations

Task
  ├── exactly one Conversation
  ├── one or more Runs
  └── outcome expressed through Messages and Artifacts

Workflow
  └── creates a Task
        └── sequences Runs

Run
  ├── one or more Attempts
  ├── ordered Events
  ├── one Engine
  ├── optional parent Run
  └── optional workflow-step metadata

Worker
  └── executes an Attempt
```

### Vocabulary Rules

- **Run** is the universal durable execution unit. It replaces `turn` as the primary runtime
  entity because schedules, webhooks, workflow steps, and delegated work are not naturally chat
  turns.
- `turn` may remain conversational prose for one user/assistant exchange, but it should not define
  a second queue, lease, event, or persistence model.
- A Run keeps its identity while paused, handed off, recovered, or retried. A retry creates a new
  Attempt.
- A user follow-up Message starts a new Run.
- A delegated agent creates a child Run with `parentRunId`; it does not create a second task model.
- A Workflow invocation creates a Task. Do not add a separate top-level `WorkflowRun` entity unless
  a concrete product need cannot be modeled by the Task and its Runs.
- `step` is reserved for a Workflow definition. Model-loop iterations are implementation details,
  not product Steps.
- `session` is only valid when qualified, such as **Engine session** or **auth session**. An
  unqualified domain `Session` is too ambiguous and should not be introduced.
- A Task does not execute; its Runs execute.
- A Worker is a process, not a user-facing record of work.
- A separate `Result` entity is unnecessary until the product needs behavior that cannot be
  expressed by terminal Messages, Task state, and Artifacts.

## Target Architecture

```text
                         CLIENTS

 Next.js web ───────┐
 Expo mobile ───────┼──── versioned HTTP + SSE/WS
 Future clients ────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │     apps/api     │
                    │   Hono / Node    │
                    │                  │
                    │ auth and actor   │
                    │ validation       │
                    │ idempotency      │
                    │ API versioning   │
                    │ stream gateways  │
                    └────────┬─────────┘
                             │ calls
                             ▼
                    ┌──────────────────┐
                    │  packages/core   │
                    │                  │
                    │ conversations    │
                    │ runs             │
                    │ tasks/workflows  │
                    │ integrations     │
                    │ billing          │
                    │ authorization    │
                    └───────┬──────────┘
                            │ repository/provider ports
              ┌─────────────┴─────────────┐
              ▼                           ▼
       packages/db                 provider adapters
       Postgres repos              GitHub, Slack, etc.
              │
              │ durable Runs and jobs
              ▼
                    ┌──────────────────┐
                    │   apps/worker    │
                    │                  │
                    │ Run execution    │
                    │ sandboxes        │
                    │ ingestion        │
                    │ polling          │
                    │ schedules        │
                    └──────────────────┘
```

Electric is an additional authorized read transport:

```text
Postgres → Electric → API-owned shape proxy → TanStack DB → web UI
```

It is not an alternative write or authorization path.

## Protocol Boundary

### Canonical Interface

The canonical client interface is:

- Versioned HTTP resources and commands under `/v1`.
- Explicit request, response, and error schemas validated at runtime.
- Versioned SSE event schemas for Run output.
- WebSocket protocols only where communication is genuinely bidirectional, such as terminals or
  dictation.
- OpenAPI generated from the same schemas for documentation and non-TypeScript clients.

Hono RPC is a compiled first-party TypeScript client over this interface. It gives web and mobile
end-to-end types without making TypeScript server internals the public protocol.

API contracts must never expose:

- Drizzle-inferred row types.
- Provider SDK response objects.
- Internal lease or recovery metadata.
- Encrypted credentials or secret locators.
- Framework-specific request/session objects.

### Actor And Authorization

Every authenticated transport resolves to one explicit actor context:

```ts
type Actor = {
  userId: string;
  workspaceId: string;
  sessionId?: string;
  role: string;
  permissions: string[];
  authenticationMethod: "session" | "oauth" | "api_key" | "service";
};
```

Core services receive this actor explicitly. Internal user and workspace IDs must not be WorkOS IDs.
WorkOS is the hosted identity adapter, not the domain identity model. This keeps a generic OIDC or
safe local-development adapter possible for the open-source distribution.

### API Contract Requirements

The public protocol should support:

- Path versioning beginning with `/v1`.
- Idempotency keys for commands that may be retried.
- Cursor pagination.
- Request and trace IDs.
- Consistent structured errors.
- Explicit resource version or optimistic-concurrency fields where simultaneous editing matters.
- Contract tests and breaking-change detection against the last released OpenAPI document.
- A documented mobile compatibility window.

## Database Boundary

The rule is not “only the HTTP process may touch the database.” The rule is:

```text
Only trusted backend composition roots access Postgres through packages/db.
No client, UI module, domain service, or provider adapter accesses it directly.
```

Trusted database consumers are limited to:

- `apps/api` through application services and repositories.
- `apps/worker` through the same application services and repositories.
- Migration and bounded maintenance commands.
- Electric's replication service.

The Worker must not call the public API for Run claims, heartbeats, event persistence, or settlement.
Those operations require short, fenced database transactions and must survive API unavailability.

Both composition roots use the same behavior:

```text
API handler ────┐
                ├──> application service ──> repository interface ──> Postgres
Worker handler ─┘
```

`packages/core` defines behavior and repository ports. It does not import a Drizzle client,
framework request object, or process environment. `packages/db` implements the repository ports.

## Electric And Local-First Feel

Electric remains a web read optimization. It does not define the complete API and is not required
by mobile initially.

### Versioned Read Models

Synchronizing internal domain tables directly would make their columns an accidental client
contract. Electric should expose only authorized, versioned read models, conceptually:

```text
chat_sessions_v1
chat_messages_v1
tasks_v1
run_events_v1
brain_documents_v1
integrations_v1
```

These may be projection tables or another Electric-compatible projection mechanism. The invariant
is more important than the physical implementation: clients receive only intentionally public
fields, and internal schema changes do not silently change the sync contract.

Clients must not supply arbitrary table names, columns, or SQL predicates to Electric. The
API-owned shape gateway chooses the read model, actor scope, workspace filter, allowed parameters,
and authorization lifetime.

### Write And Confirmation Loop

For an optimistic web mutation:

1. TanStack DB applies the local optimistic change.
2. The protocol client sends the command to the API.
3. The API authenticates the Actor and validates the DTO.
4. Core validates business invariants and authorization.
5. The repository commits the change.
6. The API returns the result and Postgres transaction ID from the same transaction.
7. Electric delivers the authoritative change.
8. TanStack DB matches the transaction and removes the optimistic overlay.

This provides local-first feel while keeping server authority. Reads may work offline, and safe
commands may be staged optimistically, but agent execution, billing, provider actions, and
confirmation-gated writes require connectivity and server authorization.

Mobile should begin with ordinary API reads and the same Run event stream. Add mobile persistence
or sync only when the mobile product demonstrates a concrete need.

## Streaming Architecture

RSC, SSE, Electric, Postgres, and Redis solve different problems.

| Concern | Technology | Responsibility |
|---|---|---|
| Web page rendering | RSC and Suspense | HTML, layouts, initial content, loading boundaries |
| Live Run output | Hono SSE or fetch streaming | Typed Events available to web and mobile |
| Terminal and dictation | WebSocket | Bidirectional interactive transport |
| Durable state | Postgres | Runs, Attempts, Messages, approvals, Artifacts, meaningful Events |
| Web read sync | Electric and TanStack DB | Authorized local read models |
| Hot replay/fan-out | Redis, only when needed | Optional transient performance layer |

### Baseline Flow

Start with a Postgres-backed Run event log:

```text
Worker
  → appends batched Run Events to Postgres
  → emits a lightweight wake notification

Hono stream endpoint
  → reads Events after cursor N
  → streams them to the client
  → reconnects from the last Event ID

Electric
  → synchronizes resulting Messages, Task state, and Artifacts
```

The exact wake mechanism may be polling or a Postgres notification initially. It must not become a
second authoritative queue.

### What Is Durable

Persist Events needed to explain or reconstruct the product:

- `run.started`
- `message.created`
- `message.content_updated` in bounded batches
- `tool.started`
- `tool.completed`
- `tool.failed`
- `approval.requested`
- `approval.resolved`
- `artifact.published`
- `run.paused`
- `run.completed`
- `run.failed`
- `run.canceled`

Tiny token deltas, cursor animation, repeated progress ticks, and terminal byte fragments may be
live-only when a durable snapshot or terminal outcome already preserves their meaning.

On reconnect, the client loads the latest durable Message and Event cursor, then resumes the live
stream. It may skip a few animation frames; it must not lose meaningful work.

### When Redis Becomes Justified

Do not introduce Redis Streams as a baseline durability layer. Add a TTL-limited Redis hot stream
only when measurements show one or more of these needs:

- Many API instances must serve the same active Run.
- Many workers publish high-frequency Events and Postgres is the measured bottleneck.
- Exact short-window replay of presentation deltas materially improves the product.
- Several independent transient consumers need the same live stream.

If added:

```text
Postgres = authoritative semantic history
Redis = temporary high-frequency replay and fan-out
SSE = client transport
```

Redis failure may degrade live smoothness or exact resumption. It must not lose a Run, Message,
approval, Artifact, or terminal outcome.

### RSC Boundary

RSC is a web rendering implementation. It may call the API to render initial authenticated state,
but it must not become the Run event protocol or a write path unavailable to mobile. Next.js Server
Actions may wrap protocol-client calls for web ergonomics; they must not contain independent domain
logic.

## Universal Run Model

Every agent execution should converge on the same durable primitive.

```text
User sends a Chat message
  → Message + Run

User starts an ad-hoc Task
  → Task + Conversation + first Message + first Run

User invokes a Workflow
  → Task + Conversation + workflow metadata + first Run

Schedule or webhook fires
  → Task or existing Conversation + Run

Agent delegates work
  → child Run

User follows up
  → new Message + new Run
```

A conceptual API flow is:

```text
create Message/Run command
  → transaction persists input and queued Run
  → response returns Run ID, Message ID, and transaction ID

Worker claims Run
  → creates Attempt
  → executes selected Engine
  → appends Events and Messages
  → settles Run and related Task state transactionally

Client subscribes to Run Events
  → live output through SSE
  → authoritative state through API/Electric
```

The API may nudge the Worker after committing a Run, but Postgres is the authoritative queue. A
lost wake adds polling latency; it cannot lose the Run.

## Minimal Monorepo Shape

The first target covers web and mobile only:

```text
apps/
  web/          Next.js presentation
  mobile/       Expo client
  api/          Hono public API composition root
  worker/       durable execution composition root

packages/
  core/         modular product monolith
  protocol/     API DTOs, Event schemas, errors, OpenAPI, typed client
  db/           Drizzle schema, migrations, repositories
  runtime/      Engines, Run execution contracts, sandbox protocols
  brain/        knowledge domain
  ui/           web UI primitives
```

Existing marketing and support applications may remain, but they do not define the product
architecture. Do not create CLI, public SDK, or docs applications until the web/mobile protocol is
proven and there is a concrete consumer.

### Core Is A Modular Monolith

Begin with vertical modules inside one package:

```text
packages/core/src/
  conversations/
  runs/
  tasks/
  workflows/
  integrations/
  billing/
  workspaces/
```

Each module exposes a small public entry point. Cross-module imports use those entry points rather
than arbitrary internal files.

Do not create separate packages for auth, integrations, billing, configuration, telemetry,
storage, or every provider until at least two real consumers need the boundary or it has an
independent release/security lifecycle.

`runtime` and `brain` remain separate because they have substantial independent responsibilities:

- Core decides what the product means and what should happen.
- Runtime executes agents across Engines and sandbox environments.
- Brain owns a knowledge model used by API, Worker, and sandbox tooling.

### Dependency Direction

```text
web/mobile ───────────────> protocol

api ──────────────────────> protocol + core + db

worker ───────────────────> core + db + runtime + brain

db/provider adapters ─────> core ports

core ─────────────────────> brain/runtime contracts where required
```

Hard rules:

- Packages never import from apps.
- Web and mobile do not import DB, core, provider SDKs, or server secrets.
- Core does not import Next.js, Hono, React, WorkOS, concrete Drizzle clients, E2B, Vercel Blob,
  or process environment.
- API and Worker are the composition roots that wire concrete adapters together.
- Provider response types do not escape their adapters.
- Web and mobile share protocol and non-visual logic. Do not force React DOM and React Native into a
  premature shared-component abstraction.

## App Responsibilities

### `apps/web`

- RSC layouts, initial rendering, and web presentation.
- Interactive React client UI.
- Hosted cookie/session handling.
- Electric and TanStack DB collections.
- Protocol-client calls for every write.
- Standard Run event subscriptions.
- No database imports, provider credentials, or domain logic.

### `apps/mobile`

- Expo presentation and native capabilities.
- The same protocol client and Run event contract.
- Ordinary API reads initially; Electric is not required.
- No duplicate domain rules or provider-specific code.

### `apps/api`

- Authentication and Actor resolution.
- Validation, idempotency, rate limits, and API versioning.
- Commands and ordinary queries.
- Electric shape authorization.
- SSE Run event gateway.
- Short-lived WebSocket and sandbox tickets.
- Translation between protocol DTOs and core commands/results.

### `apps/worker`

- Run claims and Attempts.
- Engine execution.
- Sandbox lifecycle.
- Schedules and integration polling.
- Brain ingestion and other durable background work.
- Event publication and transactional settlement.
- No public product API.

## Open-Source Posture

The open-source architecture should commit to stable capability boundaries, not to replacing every
vendor immediately.

| Capability | Product contract | Hosted default | OSS direction |
|---|---|---|---|
| Database | Postgres | Neon | Any supported Postgres |
| Durable queue | Postgres leases | Neon | Same Postgres |
| Auth | Actor/OIDC adapter | WorkOS | Generic OIDC and safe local mode |
| Models | Model gateway | Vercel AI Gateway | OpenAI-compatible adapter |
| Sandbox | Sandbox provider | E2B | Local/Docker adapter when justified |
| Object storage | Blob store | Vercel Blob | S3-compatible/MinIO |
| Secrets | Secret resolver | Infisical | Environment/file provider |
| Telemetry | OpenTelemetry | Current hosted tools | Any OTel backend |
| Sync | Optional read optimization | Electric | REST remains complete without it |
| Redis | Ephemeral coordination | Managed Redis | Optional/self-hosted |

Not every alternative adapter is required for the first release. Vendor-specific names and response
types must not become core concepts, so alternatives remain additive rather than a rewrite.

## Deliberate Simplifications

- Reuse the current monorepo.
- Keep Postgres and the proven lease queue.
- Keep API and Worker as separate failure domains while sharing code.
- Use one core package rather than a package per domain.
- Do not add Kafka, Temporal, a generalized event bus, or Redis Streams preemptively.
- Keep Electric optional and web-specific initially.
- Persist semantic Events rather than every presentation delta.
- Start mobile on the ordinary API rather than solving offline sync before product demand.
- Share protocol and logic between web/mobile, not a forced universal UI component system.
- Do not combine this refactor with a database-vendor move, TypeScript/toolchain migration, or
  observability-vendor replacement.

## Migration Principles

1. **One product first.** Delete the retired product generation and rescue its live
   responsibilities before renaming or extracting architecture.
2. **Names after deletion.** Give the surviving product real names without mixing code renames with
   storage migrations.
3. **Characterize behavior.** Preserve high-value tests around auth, tenancy, billing, Run recovery,
   integrations, and streaming before moving the path.
4. **Extract vertically.** Move one complete product flow through protocol, API, core, DB, Worker,
   web, and mobile rather than creating empty horizontal packages.
5. **Strangle Next.js carefully.** Replace direct DB and provider access domain by domain. Keep RSC
   presentation useful while removing backend ownership.
6. **Keep the product deployable.** Each PR must leave the current product working and have an
   explicit rollback path.
7. **Do not rename physical contracts accidentally.** Database schemas, stored IDs, Electric table
   names, browser storage, telemetry keys, sandbox paths, and third-party identifiers require
   explicit compatibility or migration plans.

## Deferred Decisions

These are intentionally not decided by this concept page:

- Exact HTTP resource paths and DTO shapes.
- The first vertical slice to migrate behind the API.
- The exact Postgres wake mechanism used by the SSE gateway.
- Whether Redis-backed hot replay is justified after measurement.
- The mobile persistence/offline model beyond ordinary API caching.
- The exact compatibility window for old mobile clients.
- Which physical Goat-prefixed storage contracts should migrate before the first public release.
- Which OSS alternative adapters must ship in the first release rather than remain documented
  extension points.

Each should become an ADR or implementation issue when it is the next blocking decision.

## External References

- [React Server Components](https://react.dev/reference/rsc/server-components)
- [Next.js Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components)
- [Hono streaming helpers](https://hono.dev/docs/helpers/streaming)
- [Hono RPC](https://hono.dev/docs/guides/rpc)
- [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/)
- [TanStack DB mutations](https://tanstack.com/db/latest/docs/guides/mutations)
- [TanStack DB Electric collection](https://tanstack.com/db/latest/docs/collections/electric-collection)
- [WorkOS sessions and access tokens](https://workos.com/docs/authkit/sessions)
