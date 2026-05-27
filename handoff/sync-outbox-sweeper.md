# Sync outbox sweeper

## Context

Agent and Brain saves persist sync job rows, then dispatch Inngest events from `after()`. If that post-response dispatch fails, the job row remains pending but there is no sweeper to pick it up. The architecture docs still call this out as a limitation.

Relevant code:

- `apps/web/lib/agents/create.ts`
- `apps/web/lib/agents/materialize.ts`
- `apps/web/lib/brain/actions.ts`
- `apps/web/lib/brain/materialize.ts`
- `apps/web/lib/inngest/functions.ts`
- `packages/db/src/schema.ts`
- `docs/architecture.md`

## Problem

`agent_sync_jobs` and `brain_sync_jobs` are already outbox tables, but they depend on a best-effort event dispatch. A missed dispatch means GitHub materialization can stall until another edit happens.

## Goal

Treat sync jobs as true durable outboxes with recovery independent of the initial dispatch.

## Suggested approach

Add scheduled Inngest functions that periodically scan due sync jobs:

- `agent_sync_jobs` where `status in ('pending', 'failed')` and `nextRunAt <= now()`
- `brain_sync_jobs` where `status in ('pending', 'failed')` and `nextRunAt <= now()`

For each due job, call the existing materializers:

- `materializeAgentToGitHub(agentId, { mode: "scheduled" })`
- `materializeBrainFileToGitHub({ workspaceId, path })`

Keep existing event-triggered sync functions for low latency. The sweeper is the recovery path.

## Acceptance criteria

- A failed or missed dispatch can recover without another user edit.
- Sweeper concurrency cannot run two syncs for the same agent or Brain path concurrently.
- Failed materializations preserve `attempts`, `lastError`, and retry visibility.
- Docs no longer say another edit is required to enqueue a fresh sync.
- Tests cover due-job selection and non-due job skipping.

## Verification

Run:

```sh
bun --filter @opencompany/web test
bun run typecheck
```
