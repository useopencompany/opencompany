# ADR 0003: Headless Workflow and schedule foundation

- Status: Accepted for issue [#1203](https://github.com/useopencompany/opencompany-experimental/issues/1203)
- Date: 2026-08-12
- Owners: API, web Workflow and schedule, runner, and Task maintainers
- Supersedes: the Workflow CRUD and Recurring Task scheduling boundaries documented in
  `apps/web/docs/README.md`; physical compatibility remains during the sequential cutover

## Context

Chat and Task now have canonical Core services and `/v1` resources. Workflow definitions and two
different scheduling concepts still cross the Next.js boundary directly:

- a workspace-owned Workflow may have an embedded scheduled trigger; and
- an actor-owned Recurring Task stores a preplanned execution harness.

Those resources currently share some runner machinery, but they do not share tenancy. Treating both
as one public schedule collection would let a personal Recurring Task acquire workspace visibility
or hide a Workflow trigger's owning definition. Existing scheduled execution also creates Tasks;
adding a parallel Workflow-run or schedule-run protocol would split the canonical Task runtime.

Issue #1203 requires additive, independently deployable cutovers. The first change must establish
the contract and application boundary without switching clients or destructively rewriting data.

## Decision

### Final composition boundary

The final architecture has three product composition roots with one client boundary:

- `apps/web` is a presentation client. Client and RSC reads use versioned API resources or fixed,
  authorized API-owned Electric read models. Browser mutations use the generated `/v1` client. It
  may retain Next rendering, static assets, presentation-only routing, and a same-origin transport
  proxy, but it owns no product-domain database query, server action implementation, provider
  credential, webhook, OAuth exchange, scheduler, or AI execution path.
- `apps/api` owns the generic cookie/bearer authentication boundary, Actor derivation,
  authorization, versioned HTTP/SSE resources, read-model authorization/proxying, provider ingress,
  OAuth callbacks/state/PKCE, webhook signatures/raw bodies/replay protection, and backend settings
  commands. Provider URLs move through rewrites or dual routing before a remote configuration
  changes; moving a route file alone is never a cutover.
- `apps/runner` owns durable Run execution and recovery, due-schedule claims, ingestion/polling,
  sandboxes, engine continuity, and narrow authenticated worker-control transports. It uses shared
  application services and repositories in process and never calls the public API for leases,
  heartbeats, settlement, or persistence.

Shared packages own domain behavior and adapters. `packages/core` defines provider-independent
application services and ports; protocol validation and OpenAPI stay in `packages/protocol`;
Postgres mapping stays in `packages/db`; provider-specific implementations remain in their existing
shared packages until a concrete package boundary is justified. Neither copying a web
implementation into API nor mechanically relocating files establishes ownership.

The migration proceeds as independently deployable removals: Workflow and schedules; Brain and
workspace knowledge; integrations and provider ingress; settings and billing; then Universal Chat
and compatibility deletion. Large domains split by source/provider or read/write boundary before
implementation. A temporary web adapter must have a named caller, removal signal, rollback
condition, and owner in the #1203 audit. Each slice lands from current main, proves its exact
deployed SHA and rollback boundary, and merges before the next begins.

Universal Chat is the final deletion gate. OpenCompany, Codex, and Claude Code browser Messages use
the same Message command, Conversation, Run stream, approval/answer semantics where compatible,
and durable reconnect/recovery contract while preserving their engine settings, credentials,
attachments, skills, reasoning, artifacts, interruption, sandbox continuity, and exactly-once
behavior. Issue #1203 closed the rollback window after the designated production smoke, and the
web compatibility paths were deleted. The 35 known sessionless historical Tasks and their read-only
compatibility resources are not deleted by this migration.

### Domain and tenancy

`Workflow` is a workspace-owned reusable definition with ordered `WorkflowStep` values, an
optimistic `version`, and either a manual or embedded scheduled trigger. A Workflow invocation,
including run-now and a scheduled occurrence, creates one canonical Task and Run through
`TaskApplicationService`. The persisted Workflow slug remains the stable Task association and
composer handle; clients treat all IDs as opaque.

`TaskSchedule` is an actor-owned Recurring Task scoped to the actor's current workspace. It retains
the existing Tasks & Workflows feature policy and a preplanned execution payload, but neither the
payload nor provider/runner vocabulary enters the protocol. Its run-now and due occurrences also
create canonical Tasks and Runs. Historical personal schedules whose physical `workspace_id` is
null remain visible only to their owning actor while that actor is a member of the selected
workspace; the first mutation binds the row to that workspace. This preserves existing schedules
without granting workspace-wide visibility.

Core owns validation, authorization, cron normalization as a port, planner and Task-creation ports,
optimistic conflict semantics, and orchestration. It has no Next, Hono, Drizzle, WorkOS, runner,
environment, or provider dependency. `packages/db` owns the current physical mapping and repeats
membership/ownership predicates on every query. `apps/api` is the HTTP composition root;
`apps/runner` remains the due-work authority and may use the same repository boundary directly.

### HTTP and read-model contract

The canonical commands and resources are:

| Method | Resource | Meaning |
| --- | --- | --- |
| `GET`, `POST` | `/v1/workflows` | List or idempotently create Workflow definitions. |
| `GET`, `PATCH` | `/v1/workflows/{workflowId}` | Read or version-check and update a Workflow. |
| `POST` | `/v1/workflows/{workflowId}/archive` | Version-check and archive a Workflow. |
| `POST` | `/v1/workflows/{workflowId}/invoke` | Create a canonical Task from a Workflow. |
| `POST` | `/v1/workflows/{workflowId}/run-now` | Create a canonical Task for an immediate scheduled invocation. |
| `GET`, `POST` | `/v1/schedules` | List or idempotently create actor-owned Recurring Tasks. |
| `GET`, `PATCH` | `/v1/schedules/{scheduleId}` | Read, version-check/update, pause, or resume one Recurring Task. |
| `POST` | `/v1/schedules/{scheduleId}/archive` | Version-check and archive a Recurring Task. |
| `POST` | `/v1/schedules/{scheduleId}/run-now` | Create a canonical Task from the stored execution plan. |

Create commands require `Idempotency-Key`. Reusing the same actor/workspace/key and normalized
command returns the original resource and transaction boundary; reuse for different content is an
`idempotency_conflict`. An accepted Recurring Task create is checked before the current feature
policy and before planner work, so a safe retry still returns the original result if the feature is
disabled later; a new command remains feature-gated. Updates and archives require
`expectedVersion`; stale writes return `conflict` instead of overwriting a newer editor or scheduler
change.

Electric clients select only API-owned names:

- `workflows-v1` for workspace Workflow definitions;
- `workflow-schedules-v1` for workspace Workflow trigger projections; and
- `task-schedules-v1` for actor/workspace Recurring Task projections.

The API owns table, columns, predicates, and parameters. Tenancy fields, planner payloads, WorkOS
names, and physical table names do not cross that boundary. Empty historical Workflow drafts remain
readable, while mutation and invocation rules prevent executing incomplete definitions. The
Workflow projection stores its discriminated trigger as one JSON value so Electric can never expose
a partial cron/timezone/prompt update assembled from independently delivered columns.

### Additive persistence and scheduling authority

Migration `0207_goat_headless_workflow_foundation.sql` adds versions, command reservations, and the
three fixed read projections. Projection triggers and backfill preserve existing source rows and
synthesize a canonical step from legacy `instructions`/`model` fields when needed. No existing
table, column, Workflow, schedule, or run history is dropped or renamed.

Cron parsing and next-occurrence calculation reuse the current agent-runtime rules. For Workflow
updates and Recurring Task creates/updates, Core calculates the schedule and prepares execution
before the versioned database write. The runner continues to be the only due-occurrence claimant;
this foundation does not create another timer or queue. Run-now writes an occurrence audit row only
after canonical Task creation, using Task creation time as the stable occurrence key.

The first PR does not cut over web readers/writers or runner claims. Subsequent PRs switch one
surface at a time, verify its deployed release and rollback path, then remove its prior boundary.
There is no dual write: a caller uses either the old adapter before cutover or the Core service
after cutover.

### Web boundary ratchet

The initial audit records every production `apps/web` source file importing `@opencompany/db` or
`drizzle-orm`. CI compares the exact set. New direct imports fail immediately; each cutover removes
entries from the checked-in baseline until it reaches zero. Comments that merely name a package do
not count as imports, and tests are excluded because the rule protects the production composition
boundary.

## Consequences

- Workflow and Recurring Task clients can migrate without learning physical storage or runner
  payloads.
- Workspace Workflow triggers and actor-owned Recurring Tasks remain visibly distinct resources.
- Every automation execution converges on canonical Task/Conversation/Run behavior.
- Existing rows and the current scheduler stay valid while later PRs cut over clients and claims.
- Planning may perform external work before a concurrent version check loses. That is bounded wasted
  work, not a state inconsistency; the database version remains authoritative.

## Rollout and rollback

PR 1 deploys the additive migration, API resources, projections, characterization, and boundary
ratchet with no client activation. Reverting the application release restores all existing callers;
the additive columns, reservations, and projections may remain safely deployed. The migration must
not be reversed by dropping them while any newer release or reservation can still reference them.

After a later client cutover, rollback restores that client's previous adapter while leaving the API
and runner capable of completing canonical Tasks already created. A canonical Task is never moved to
the legacy queue. Projection tables are rebuildable from source rows, but source Workflow, schedule,
Task, Conversation, Run, and occurrence history is never deleted as part of rollback.

Production verification records the exact web/API/runner release SHAs, designated test actor and
workspace, anonymized durable IDs, idempotency replay, optimistic conflict, Electric projection, due
execution, and rollback evidence on #1203. Final deletion remains gated on the authenticated smoke
owned by #1190.
