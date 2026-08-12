# ADR 0002: Canonical Task runtime and compatibility boundary

- Status: Accepted for issue [#1190](https://github.com/useopencompany/opencompany-experimental/issues/1190)
- Date: 2026-08-11
- Owners: API, web Task, Workflow, schedule, agent-tool, and runner maintainers
- Supersedes: the Task execution model documented in `apps/web/docs/README.md`; physical legacy
  compatibility remains bounded as described below

## Context

Canonical Chat established `Conversation`, `Message`, `Run`, `Attempt`, and `Event` as the durable
execution vocabulary. Tasks still enter that runtime through several Task-session constructors,
while web routes and actions own Task validation, authorization, reads, writes, continuation, and
cancellation. Workflow step progression can replace a Task's session, and historical sessionless
Tasks still read from Task-specific message and event tables.

The repository audit for #1190 traced every current reader, writer, creator, queue, schedule path,
agent tool, Electric shape, and persistence path. Its keep/migrate/delete inventory is recorded in
the issue's
[audit update](https://github.com/useopencompany/opencompany-experimental/issues/1190#issuecomment-5257606452).
The audit establishes ownership by call graph rather than filename and is the deletion checklist
for this phase.

## Decision

### Domain ownership

A Task is tracking metadata around exactly one Conversation. It owns the goal, name, source,
Workflow/schedule references, lifecycle projection, outcome, and archive state. The Conversation
owns all user and assistant content. Runs execute work; a Task never has its own execution
protocol.

The canonical public terms are `Task`, `Conversation`, `Message`, `Run`, `Attempt`, and `Event`.
Task sessions, harnesses, provider sessions, leases, WorkOS keys, table names, and runner state are
persistence details and do not cross `/v1`.

`packages/core` owns the actor-explicit Task application service and repository port.
`packages/db` owns its Postgres mapping. `apps/api` and `apps/runner` are composition roots over the
same service; backend callers do not call the public API. Manual web creation, Workflow invocation,
schedule claims, and agent host tools will all enter this service after the sequential creator
cutover. There is no second application service for a creator type.

### Public contract

The minimum Task surface is:

| Method | Route | Meaning |
| --- | --- | --- |
| `GET` | `/v1/tasks` | List actor-visible active or archived Tasks with an opaque cursor. |
| `POST` | `/v1/tasks` | Atomically create a Task, Conversation, initial Message, and queued Run. |
| `GET` | `/v1/tasks/{taskId}` | Read Task metadata and its one `conversationId`. |
| `PATCH` | `/v1/tasks/{taskId}` | Rename a Task and its Conversation, or archive/restore a terminal Task. |
| `GET` | `/v1/tasks/{taskId}/summary` | Read API-owned canonical or compatibility usage and duration totals. |
| `GET` | `/v1/compatibility/tasks` | List bounded, sessionless pre-cutover Task metadata. |
| `GET` | `/v1/compatibility/tasks/{taskId}/history` | Read a sessionless Task's immutable legacy transcript and events. |

`POST /v1/tasks` requires `Idempotency-Key`. The normalized command hash includes the Task name,
goal, engine, concrete model, ordered attachment IDs, source, and optional Workflow/schedule
metadata. A replay in the same actor and workspace returns the original Task, Message, assistant
placeholder, Run, and Postgres transaction boundary. Reusing a key for different input is an
`idempotency_conflict`.

Follow-up work uses `POST /v1/messages` with the Task's `conversationId`. Observation and
cancellation use the canonical Run routes. This phase does not add Task-message, Task-stream,
Task-retry, or Task-cancel endpoints.

### Persistence mapping

Postgres remains authoritative. Existing physical names are retained behind repositories while
the compatibility window is open:

| Canonical concept | Physical mapping during this phase | Invariant |
| --- | --- | --- |
| Task | `goat.tasks` | `session_id` is the one Conversation link; its existing partial unique index prevents two Tasks from owning one Conversation. |
| Conversation | `goat.chat_sessions` with kind `task` | Every new Task creates exactly one row and never replaces this link. |
| Message | `goat.chat_messages` | Initial and follow-up content uses the canonical Message store. |
| Run | `goat.codex_chat_turns` | Every unit of Task work is queued as a canonical Run. |
| Attempt / Event / Approval | canonical Run tables introduced by ADR 0001 | Claims, retries, fencing, recovery, semantic progress, and decisions are shared with Chat. |
| Runtime container | `goat.codex_chat_sessions` | Temporary adapter detail for the retained runner; not a Task identity. |
| Command replay | additive `goat.task_command_idempotency` | Actor/workspace/key uniqueness and stable IDs for the atomic first command. |
| Authorized Task read model | additive `goat.task_read_model_v1` | API-owned projection; Electric is a read optimization only. |

Migration `0202_goat_headless_task_foundation.sql` is additive. It records Task source, adds command
idempotency and the fixed Task projection, broadens the canonical Message projection to Task-kind
Conversations, and backfills only session-backed Tasks into the new read model. It does not rename
or drop a Task table, create Task-specific message/event storage, or modify legacy Task history.
Sessionless historical Tasks remain deliberately outside the canonical projection until the
bounded compatibility adapter is implemented and verified.

The Task create repository uses one data-modifying Postgres statement to reserve the command,
create Task and Conversation metadata, insert the initial user Message and assistant placeholder,
create the runtime adapter, enqueue the Run, append `run.queued`, claim attachments, and return the
transaction boundary. Any unavailable attachment or failed insert rolls back the whole command.

### Authorization and read models

The API derives Actor and Workspace from authenticated session or bearer identity. Task commands
do not accept an actor or workspace identifier. Repository predicates recheck current workspace
membership; removing membership immediately removes workspace Task access, including idempotent
replay. Task creation also evaluates the existing Task feature policy under a locked actor row.

Workspace-owned Tasks retain current workspace-member visibility. Historical Tasks without a
workspace remain owner-visible only. Fixed Electric shapes use the same rule server-side:
`tasks-v1` is scoped to the authenticated workspace, while Message and Run shapes require an
authorized Conversation lookup first. Clients cannot supply a table, columns, predicate, actor, or
workspace.

### Lifecycle policy

The protocol lifecycle is `queued`, `running`, `waiting`, `blocked`, `succeeded`, `failed`,
`canceled`, and `archived`. During the additive mapping, retained physical Task states map directly
for queued/running/succeeded/failed/canceled, and a non-null archive timestamp takes precedence as
`archived`. `waiting` and `blocked` are reserved canonical states and will be projected only when a
real supported Run boundary supplies them; they are not inferred from arbitrary runner details.

Archiving is metadata, not cancellation. Only a terminal Task can be archived. Active work is
canceled through the current Run command, after which the Task lifecycle projector may settle it
as canceled. Retries create an Attempt or a later Run according to canonical Run semantics and
never replace Task identity or Conversation identity.

## Sequential compatibility window

The compatibility period is explicitly bounded to the four merged PRs required by #1190:

1. Contract and repository foundation adds the application service, `/v1` contract, additive
   storage, authorized read model, characterization, and this ADR. No existing client or creator is
   cut over.
2. Canonical Task execution moves every creator to the one service. Existing legacy queue work may
   drain, but new Tasks cannot enter it. Compatibility metrics distinguish pre-cutover work.
3. Web Task cutover moves writes to typed `/v1` commands and reads to API resources/fixed shapes.
   Direct web Task mutation stops; legacy history remains readable.
4. Compatibility migration and deletion records drain/backfill and production evidence, removes
   the duplicate execution path, and retains only historical read compatibility that real rows
   require.

This is not a permanent dual-write design. A creator uses either the old constructor before its
cutover or the canonical application service after it; no Task is written to two execution
protocols. Deletion requires caller, queue, runner, release, and production evidence from the exact
deployed SHA.

PR 2 establishes that cutover boundary: manual, Workflow, schedule, and agent producers all invoke
`TaskApplicationService`; Task follow-ups and cancellation invoke `ChatApplicationService`; and
Workflow/scheduled internal handoffs append a canonical Run to the Task's original Conversation.
The retained legacy constructor has no production caller. The shared worker emits
`opencompany.legacy_task_run_claimed` and increments `goat.legacy_task_runs_total` only when it
claims a Task Run without the canonical `run.queued` event. That signal is the bounded drain metric
for PR 4, not a routing flag.

Migration `0203_goat_task_schedule_workspace.sql` binds every new recurring schedule to the
workspace in which it was created and revalidates that membership when it fires. Pre-cutover
user-scoped schedules retain a nullable workspace only during the compatibility window; their
deterministic fallback emits `opencompany.legacy_task_schedule_workspace_fallback` and must be
resolved before PR 4 removes that branch.

PR 3 establishes the client boundary. Browser creation, archive, follow-up, and cancellation use
the generated `/v1` client; follow-up targets the Task Conversation's Message command and
cancellation targets its active Run. Task list/detail state comes from `tasks-v1` plus the canonical
Message and Run read models. The Next.js `/api/tasks` facade, Task continuation protocol, direct
Task archive action, server-side Task list/detail loaders, and physical Task Electric shapes are
removed. The web process retains only internal producer adapters that invoke
`TaskApplicationService`; it does not authorize, validate, or persist Task state itself.

Sessionless rows stay outside `tasks-v1`. During the bounded window, the API exposes only their
actor-scoped metadata, transcript, and historical events through `/v1/compatibility/tasks*`.
Clients cannot continue, cancel, archive, or request live physical shapes for those rows. The Task
surface labels this history read-only. PR 4 may delete this adapter only after production inventory
proves no historical rows require it; otherwise it remains with an explicit follow-up deletion
condition.

The frozen `/api/chat` and legacy Chat adapter are unaffected. Workflow invocation moves in this
phase, but Workflow editor/catalog CRUD does not. Expo/mobile, macOS, broad web DB cleanup, runner
renaming, and new infrastructure remain out of scope.

## Rollback

PR 1 has no client cutover. Reverting its API/repository code returns every existing creator and
reader to the prior behavior. The additive migration, source values, command reservations, and
read-model rows may remain safely deployed and must not be destructively rolled back.

After PR 2, rollback first disables canonical creation at its caller boundary and restores the
legacy creator adapter only for new work. Already queued canonical Runs continue on the shared
runner; they must not be moved to the legacy queue. After PR 3, rollback restores the previous web
bundle and its bounded adapters while the API and runner stay capable of completing canonical work.
Existing canonical Tasks must never be moved to the legacy queue; the additive API resources and
read models may remain deployed. PR 4
deletion begins only after the evidence gate; any retained historical compatibility data is not
dropped as part of a code rollback.

Production verification uses only the designated test actor/workspace. Stateful smoke evidence
records anonymized durable identifiers and exact release SHAs on #1190; absence of operator access
is documented as a concrete missing matrix rather than worked around with unrelated production
data.
