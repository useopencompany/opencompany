# ADR 0004: Proposed unified durable-execution state model

- Status: Proposed for issue
  [#1301](https://github.com/useopencompany/opencompany-experimental/issues/1301)
- Date: 2026-08-19
- Owners: core, database, API, and runner maintainers
- Implementation gate: the harness-neutral boundary in
  [#1300](https://github.com/useopencompany/opencompany-experimental/issues/1300)
- Extends: [ADR 0001](./0001-headless-chat-v1-foundation.md) and
  [ADR 0002](./0002-headless-task-v1-foundation.md)

## Decision summary

Use one engine-neutral durable execution model for Chat and Task work:

```text
Task (optional) ──1:1── Conversation ──1:N── Message
                             │
                             └─────────1:N── Run ──1:N── Event
                                              ├──1:N── Attempt ──0:1── active lease
                                              └──1:N── Approval
```

- A Task remains product metadata around one Conversation, not an execution stack and not an
  annotation on one Run. One Task Conversation may contain several Runs.
- A Run owns user-visible execution state, cancellation intent, retry eligibility, and its ordered
  semantic Event sequence.
- An Attempt is the only lease owner. A Run and an engine interaction may refer to the active
  Attempt, but neither duplicates its lease.
- `run_events` is the only product event log. Provider-event receipts may remain as a bounded,
  non-product deduplication/debug store; legacy `task_events` remains read-only until the historical
  Task retention gate is satisfied.
- One domain-discriminated command table owns the common idempotency envelope. Each operation's
  result remains a runtime-validated typed payload.
- Lifecycle values and transition graphs live in `@opencompany/core`. Drizzle generates text
  `CHECK` constraints from those values; repositories perform fenced, compare-and-set transitions.
  PostgreSQL enums and transition triggers are not required.

This is a target and migration sequence, not approval for a big-bang schema rewrite. In particular,
it does not authorize migrations before #1300 establishes neutral Harness adapters and event
normalization.

## Answers to the investigation questions

1. **Can Task become a trigger/annotation on the Run primitive?** Task should become metadata and
   an outcome projection around one Conversation, not one Run. Scheduling creates the first Run;
   workflow steps and wakeups may append more Runs. Task stage becomes derived progress, while the
   closer remains Task-specific orchestration over a terminal Run.
2. **Can Attempt be the sole lease owner?** Yes, after claim and Attempt creation become one atomic
   operation. Attempt owns worker, token, expiry, and heartbeat; Run retains cancellation/retry
   intent, and interactions refer to Attempt identity instead of copying a token.
3. **Which Event log survives?** `run_events` is the sole product log. `task_events` remains
   immutable compatibility history. `codex_chat_events` is not merged; measured provider-event
   deduplication may move to a neutral, bounded receipt store with no product reader.
4. **Can command idempotency converge?** Yes. Use one domain-discriminated envelope and preserve
   today's domain-scoped key uniqueness. Operation results and incomplete-command metadata remain
   strict per-operation payloads rather than unvalidated generic JSON.
5. **Where do lifecycle policy and checks live?** Values, transition graphs, and a generic
   `applyTransition()` live in `@opencompany/core`. Drizzle generates text membership checks from
   the values; repository compare-and-set SQL enforces transitions and Attempt fencing. Do not add
   PostgreSQL enums or duplicate the graph in triggers.

## Current-state findings

The issue description predates the final Task cutover. Main is already materially closer to the
target than the physical schema suggests.

| Concern | Current authority | Finding | Target disposition |
| --- | --- | --- | --- |
| Task identity | `goat.tasks` | Current Tasks have a unique `session_id` and execute through their Task Conversation. | Keep the metadata record and Conversation link. Remove its execution responsibilities. |
| Task Messages and Events | `goat.task_messages`, `goat.task_events` | Production code only reads these for sessionless compatibility history. New Task work uses `chat_messages` and `run_events`. | Keep read-only behind the ADR 0002 retention gate, then archive or drop together. Never dual-write. |
| Task usage | `goat.task_*_usage` | Current Task summaries use canonical Chat ledger/Message data when `session_id` exists and legacy usage only for sessionless rows. | Keep legacy rows read-only. Attribute new usage to Run/Attempt through the canonical billing/runtime path. |
| Run work row | `goat.codex_chat_turns` | This is the physical Run, queue row, live lease owner, retry counter, cancellation row, and event-sequence allocator for all engines. | Keep it behind a neutral Run repository during migration. Do not make convergence depend on a cosmetic table rename. |
| Attempts | `goat.run_attempts` | The worker first claims the Run lease, then inserts an Attempt in a second operation. The Attempt copies `lease_id` but owns no expiry. | Create the Attempt atomically during claim and move lease expiry/heartbeat authority to it. |
| Engine interactions | `goat.codex_chat_interactions` plus `goat.run_approvals` | An interaction copies the Run lease as a fencing token. Its canonical Approval already has `attempt_id`. | Use Attempt identity for fencing and converge structured questions/permissions on neutral Approvals or elicitations after #1300. |
| Semantic Events | `goat.run_events` | Ordered, versioned, Run/Attempt-scoped, protocol-facing, and already written for Chat and current Tasks. | Keep as the sole product event log. |
| Engine event receipts | `goat.codex_chat_events` | Stores redacted normalized/raw engine events and provides engine-event deduplication for projection. It is not equivalent to a semantic Run Event. | Replace with a Harness-neutral, retention-bounded receipt store if deduplication is still needed. It must not feed product reads directly. |
| Command replay | five `*_command_idempotency` tables | The reservation envelope is duplicated, but result and completion semantics now differ across Chat, Task, automation, knowledge, and billing. | Converge the envelope and preserve typed per-operation results and domain-scoped keys. |
| Lifecycle | core constants, schema-local types, hard-coded checks, raw SQL predicates | Attempts and Run Events already generate checks from core constants; Conversation, physical Run, Task, and read-model vocabularies still diverge. There is no shared transition graph. | Put values and transitions in core; generate membership checks and use repository compare-and-set transitions. |

The migration-journal problem cited in #1301 has also been partly resolved. `bun run
db:migrations:check` is in CI and currently recognizes 217 journaled migrations plus the explicit
historical `0102_goat_brain_folder_defaults` exception. Applied history must not be renumbered.
A follow-up guard may pin the existing duplicate numeric prefixes (`0102`, `0183`) and missing
`0206` as historical exceptions while rejecting new prefix collisions; that is independent of this
state-model migration.

## Target ownership and invariants

### Conversation and Message

A Conversation owns its ordered Messages. Task and ordinary Chat Conversations use the same
Message store and command path. A Conversation may optionally have one Task metadata owner, enforced
by the existing partial unique Task Conversation index.

Conversation runtime health is a projection of the Harness session and active Run. It is not a
second Run lifecycle. Fields such as `active_turn_id` may remain as rebuildable read optimization,
but must not authorize work.

### Run

A Run is stable across worker claims and retries. It owns:

- Conversation, trigger Message, and assistant Message identity;
- an immutable Harness engine/model/config snapshot for that Run;
- canonical lifecycle status and cancellation intent;
- `run_after`/retry eligibility for delayed work;
- the monotonic Event sequence allocator; and
- terminal error and completion metadata.

The neutral lifecycle remains the existing public vocabulary:

```text
queued -> running -> paused -> queued
   |         |          |
   |         +----------+----> completed | failed | canceled
   +--------------------------> canceled
```

`paused` is the supported waiting-on-user boundary. New `waiting` or `blocked` semantics should not
be materialized until a real product behavior distinguishes them. During migration, the repository
maps physical `interrupted` to canonical `canceled`; a later narrow migration may converge the
literal without renaming unrelated physical tables.

### Attempt and lease

Each successful claim creates one Attempt transactionally. The Attempt owns:

- `worker_id` as the lease owner;
- a globally unique, unguessable `lease_id` fencing token;
- `lease_expires_at` and heartbeat time;
- monotonically increasing number within its Run; and
- `running`, `completed`, `failed`, `canceled`, or `abandoned` status and error metadata.

There may be at most one `running` Attempt per Run. Claim uses `FOR UPDATE SKIP LOCKED`, abandons an
expired Attempt, and inserts the next Attempt in the same transaction. Heartbeat changes only the
Attempt. Every worker mutation proves `(attempt_id, lease_id, worker_id, status = 'running')` in the
same statement that changes Run, Message, Event, Approval, artifact, usage, or Task projection
state. Expiry does not by itself authorize an old worker: reclaim first changes the old Attempt to
`abandoned`, so its later writes fail the status fence.

The Run keeps cancellation intent and retry timing because those survive an Attempt. It does not
keep `lease_id`, `lease_owner`, `lease_expires_at`, or a separately writable attempt counter. Attempt
count is derived from Attempt number/count and may be projected onto read models.

Structured Harness questions and permission requests refer to `attempt_id`; they do not copy the
lease token. `run_approvals.attempt_id` already provides this relationship. When an Attempt is
abandoned, its unresolved interaction is no longer actionable and recovery either reissues it under
the next Attempt or cancels it according to the Harness adapter contract.

### Event and Harness adapter boundary

`run_events` is the sole durable product/replay log. Its envelope remains:

```text
id, run_id, attempt_id?, sequence, schema_version, type, payload, created_at
```

Canonical payloads are discriminated, versioned schemas owned by core/protocol and validated before
write. The database enforces positive schema versions and known type membership, rather than pinning
all rows forever to `schema_version = 1`. Readers explicitly reject or safely skip unsupported
versions; they do not treat arbitrary JSON as a valid Event.

The Harness adapter introduced by #1300 converts engine output into neutral semantic updates. The
model accommodates the Agent Client Protocol's `session/update` categories—message/thought content,
tool call/update, plan/update, and usage update—without persisting ACP JSON-RPC or any provider's raw
event as the product contract. See the ACP
[protocol overview](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/overview.mdx)
and [versioned schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json).
The canonical set should include neutral message, reasoning, tool, plan, usage, approval, artifact,
and Run lifecycle events. High-volume chunks may be coalesced into versioned snapshots, as the
current projector already does for assistant content.

Engine-event deduplication is a separate adapter concern. If it is still necessary after #1300,
use a neutral receipt keyed by `(run_id, harness, provider_event_key)`, with an optional Attempt,
redacted raw payload, size limit, and explicit retention. Receipt failure must be observable, but
receipt rows are not returned by `/v1/runs/{id}/events` and never determine product history after a
canonical Event has committed.

### Task

A Task does **not** become an annotation on one Run. It remains an optional annotation on one
Conversation because a Task can have an initial Run, workflow-step Runs, scheduled-wakeup Runs, and
user follow-up Runs while retaining one identity and transcript.

Task-specific behavior remains outside the Run primitive:

- Schedule and Workflow definitions decide when to create a Task and its first Run. They remain
  orchestration metadata, not a second queue.
- `run_after` delays an already-created Run; it does not replace recurring schedule state.
- The Task closer evaluates the completed work, records Task result/reported outcome, and may append
  the next Workflow Run to the same Conversation. It consumes a terminal Run outcome and does not
  own leases, Messages, Attempts, or Events.
- Task `status` is a product projection updated transactionally from canonical Run transitions.
  `archived` remains derived from `archived_at`, not a stored execution state.
- Harness configuration is snapshotted immutably on each Run. Task/Workflow orchestration may retain
  a definition or progress cursor, but `tasks.harness_spec` must not be the mutable execution truth
  for a claimed Run.
- The physical `stage` column is not in the canonical Task contract. Planning, sandbox acquisition,
  and tool progress come from Run/Attempt/Event state and should not be independently writable Task
  lifecycle values.

The Task row keeps identity, display metadata, owner/workspace, goal/source, Conversation,
Workflow/schedule provenance, outcome, archive state, and timestamps. Legacy execution columns may
remain physically while sessionless history is retained, but current writers stop treating them as
authority.

### Usage and cost

Do not introduce a speculative all-purpose usage table as part of the lease migration.

- `credit_ledger` remains billing/cost authority for current Chat and Task work.
- New billing records should carry neutral Run/Attempt attribution when that attribution is needed
  for reconciliation.
- Sandbox metering should gain Run/Attempt references through the canonical repository; its current
  `chat_` physical name can remain behind the adapter.
- Typed `usage.updated` Events may expose replayable token/usage progress, but Events do not replace
  the billing ledger.
- The three `task_*_usage` tables remain immutable compatibility data and retire with sessionless
  Task history.

This makes future cost accounting a Run concern once, without forcing model, tool, sandbox, and
external billing facts into one weakly typed row shape.

### Command idempotency

One polymorphic table is appropriate for the shared reservation envelope, with two constraints:
domain isolation and typed results must survive the merge.

The target envelope is conceptually:

```text
command_id
actor_id, workspace_id
domain, operation, idempotency_key
request_hash
status, result, metadata
transaction_id?, completed_at?
created_at, touched_at
```

The unique key is `(actor_id, workspace_id, domain, idempotency_key)`, not just the user-provided
key. This preserves today's ability to reuse a key in different command domains. `result` and
`metadata` are JSONB only at the storage boundary: each operation has a strict schema in core and
its repository parses both before write and after read. Chat/Task stable resource IDs, knowledge
initial-state hashes, and billing's incomplete external-operation state therefore remain typed.

The table does not own domain business state and should not acquire nullable columns for every
resource type. PostgreSQL foreign keys from generic payloads are unavailable today, but the five
existing tables also store most returned resource IDs as unconstrained text, so convergence does
not discard an existing referential guarantee.

### Lifecycle source of truth

`@opencompany/core` owns immutable allowed-value tuples and transition maps for Run, Attempt, Task,
Approval, and other canonical aggregates. A generic pure `applyTransition(machine, current, next)`
returns the next state or a typed conflict. Application services use it to decide intent.

Repositories still enforce concurrency in the database. They issue compare-and-set updates whose
`WHERE` clause contains the expected current states and, for worker writes, the active Attempt
fence. A zero-row result is a conflict or lost lease. Multi-aggregate transitions such as terminal
Run + Attempt + Task projection + Events commit in one transaction.

Drizzle imports the core value tuples and generates text `CHECK (... IN (...))` constraints, as
`run_attempts` and `run_events` already do. Text plus generated checks is preferable to `pgEnum`:
it supports additive expand/contract deployments and rollback without PostgreSQL enum-label
coordination. Membership checks do not attempt to encode history. Database transition triggers
would duplicate the core graph and make multi-step migrations harder, so they are out of scope
unless evidence later shows repository bypasses that cannot be removed.

## Migration sequence

Each phase is independently releasable. Destructive cleanup follows production evidence from the
exact release SHA; no phase assumes that a passing local migration proves old writers are gone.

### 0. Preserve the already-completed boundary

- Keep current Tasks on canonical Conversation/Message/Run paths.
- Keep sessionless Task history read-only and do not backfill it into live queues.
- Keep the migration-journal CI check. Track future numeric-prefix hardening separately.

### 1. Land #1300 and characterization first

- Introduce neutral Harness adapter, session, event, and settings names in application code.
- Make every Run snapshot its Harness engine, model, and validated config.
- Normalize Codex, Claude Code, OpenCompany, and future ACP events before persistence.
- Add characterization coverage for claim/reclaim, heartbeat loss, graceful handoff,
  infrastructure retry, cancellation, approval/question resolution, Task continuation, and
  terminal settlement.
- Record production inventories for active Runs, running Attempts, pending interactions,
  sessionless Tasks, and writes to legacy Task tables.

No state-model migration proceeds while the worker still treats Codex helpers or event vocabulary
as the shared interface.

### 2. Centralize lifecycle contracts

- Move canonical value tuples and transition graphs to core and make physical adapters explicit.
- Generate every touched Drizzle membership check from those tuples.
- Route Run/Attempt/Task mutations through repository transition methods with compare-and-set
  predicates.
- Preserve public values and map physical `interrupted` to `canceled` until a narrow data migration
  is safe.

This phase is behavior-preserving and establishes the guardrails used by later data changes.

### 3. Expand Attempt leases

- Add nullable `lease_expires_at`/heartbeat fields to `run_attempts` and an invariant allowing at
  most one running Attempt per Run.
- Change claim so Run locking, expired-Attempt abandonment, next-number allocation, Attempt insert,
  and the Run's first `running` transition are atomic.
- During one bounded compatibility release, mirror the new Attempt lease onto the old Run lease
  columns and require both old and new claim code to respect the active-Attempt invariant. This
  closes the current claim-to-Attempt insertion window and permits an application rollback.
- Backfill or abandon only active rows whose Run lease and Attempt lease match; quarantine and
  investigate mismatches rather than choosing a winner silently.

### 4. Cut authority over to Attempt

- Heartbeat, event append, settlement, artifact/usage writes, Task projections, and interaction
  resolution fence on Attempt.
- Replace interaction `lease_id` use with `attempt_id`; converge engine questions on neutral
  Approval/elicitation records where #1300 permits it.
- Derive Attempt count from Attempt rows and stop using the Run counter as authority.
- Observe at least one deploy/handoff/retry window with no old lease predicates or mismatches.
- Then stop the compatibility mirror. Drop Run lease columns only after older worker releases are
  no longer deployable.

### 5. Make canonical Events complete

- Add versioned neutral event payload schemas for Harness message/reasoning/tool/plan/usage updates.
- Change the schema-version constraint from exactly 1 to a positive supported version policy.
- Make adapters append canonical Events before publishing presentation updates.
- If provider deduplication is still required, add the neutral bounded receipt store and switch all
  adapters to it.
- Stop writing `codex_chat_events`, retain it for the agreed audit window, then remove it separately.
  Do not backfill raw provider events into `run_events`.
- Keep `task_events` unchanged until the ADR 0002 historical-retention decision.

### 6. Slim the Task projection

- Snapshot Harness config on each new Run; treat any Task-level Harness document as orchestration
  input only.
- Project Task status/outcome from canonical Run settlement and stop writing Task lease, retry,
  sandbox, engine-session, and stage fields.
- Verify all Task creators still enter `TaskApplicationService` and all continuations append Runs to
  the original Conversation.
- Remove unused current-Task execution columns only when doing so does not mutate protected
  sessionless history. Otherwise leave them deprecated until that history is archived or deleted.

### 7. Converge idempotency one domain at a time

- Add the generic command table and strict per-operation result schemas.
- Backfill one source table at a time with its domain discriminator, preserving command IDs,
  request hashes, result IDs, completion state, and timestamps.
- Read the new table first and the old table as a bounded fallback. While rollback to an old release
  remains supported, write an equivalent legacy reservation in the same transaction.
- Verify same-hash replay, different-hash conflict, incomplete knowledge/billing recovery, and
  resource materialization for every operation.
- Stop the legacy mirror per domain, observe production, then drop that domain table. Billing moves
  last because it crosses Stripe and can contain intentionally incomplete commands.

### 8. Retire compatibility data separately

- Apply the ADR 0002 retention gate to sessionless Task Messages, Events, and usage.
- Apply the explicit audit-retention gate to old engine receipt rows.
- Only then drop compatibility tables and deprecated columns.
- Keep physical `codex_chat_*` names behind neutral repositories unless #1300 independently
  justifies a narrow rename. New tables, types, metrics, and APIs must use Harness/Run terminology.

## Verification gates

Before each contract step, require automated tests plus production evidence:

- no new writes to legacy Task Message/Event/usage tables;
- no Run with more than one running Attempt;
- no claimed Run without the matching active Attempt after the expand release;
- no successful worker mutation after its Attempt becomes abandoned or expires and is reclaimed;
- handoff, retry, cancellation, approval/question, and delayed `run_after` behavior under mixed
  compatibility releases;
- contiguous, unique Event sequences and replay parity between stored Events and `/v1` SSE;
- no product reader of provider receipt/raw-event payloads;
- idempotency replay/conflict parity before and after each domain cutover; and
- Task list/detail/summary parity for current Tasks plus unchanged sessionless compatibility reads.

JSONB writers must parse canonical Message presentation, Run Event payloads, Harness config,
Approval request/response, and command results at their repository boundary. Raw provider receipts
are redacted, size-bounded, and never trusted as canonical input.

## Rollback

- **Contracts/lifecycle:** revert application code; additive constants/tests have no data rollback.
  Membership constraints may remain if the older release accepts the same values.
- **Attempt lease expansion:** additive columns and indexes remain. The bounded compatibility release
  mirrors Attempt authority into old Run lease columns, so the previous worker can be restored
  without inventing a lease. Never run old and new claim algorithms together unless both honor the
  active-Attempt invariant.
- **Attempt authority cleanup:** once Run lease columns are dropped, rollback to a lease-on-Run
  worker is no longer safe. Restore through a forward compatibility migration or fix-forward.
- **Events:** keep old engine receipt tables through the rollback window. Reverting adapters resumes
  their writes; canonical Events already committed remain valid. Never translate semantic Events
  back into provider events.
- **Task projection:** retained metadata and legacy history are untouched. Reverting the projector
  may resume writes only while deprecated columns still exist; accepted Runs continue on the
  canonical queue.
- **Idempotency:** legacy reservation mirrors remain until old releases are retired. A rollback reads
  the same command IDs and cannot repeat an external side effect. After a domain table is dropped,
  rollback requires a forward compatibility view/migration, not recreation from guesses.
- **Destructive retention:** no application rollback reconstructs deleted historical Task or raw
  audit data. Those drops require separate approval, export/retention evidence, and a data rollback
  plan.

## Rejected alternatives

### Make Task reference one Run

Rejected because a Task Conversation can contain multiple workflow, wakeup, and follow-up Runs.
This would reintroduce either mutable Run identity or a second Task execution protocol.

### Keep the live lease on Run and treat Attempt as history

Rejected because claim, Attempt creation, interaction fencing, and recovery then continue to copy
one authority across rows. Attempt-scoped authority gives retries and reclaim a single durable
fence.

### Put raw Harness/ACP events directly in `run_events`

Rejected because provider protocols evolve independently, include high-volume/debug data, and do
not form the stable OpenCompany replay contract. Normalize first; retain receipts only for bounded
deduplication or diagnostics.

### Use PostgreSQL enums or transition triggers everywhere

Rejected because enum evolution and trigger rollout complicate expand/contract releases, while
triggers would duplicate core's transition graph. Generated text checks plus fenced repository
updates enforce the required invariants with one application-level vocabulary.

### Rename every legacy physical table as part of convergence

Rejected because repositories and `/v1` read models already hide physical names. The target is
engine-neutral in domain, code, metric, Event, and new-schema naming; cosmetic applied-schema
renames are not a prerequisite for correctness.
