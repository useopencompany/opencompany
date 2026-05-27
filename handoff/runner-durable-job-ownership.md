# Runner durable job ownership

## Context

Runner endpoints still acknowledge work before the work is durably owned. `apps/runner/src/server.ts` returns `202` after spawning unawaited in-process promises for session start, message run, title generation, and after-session work. Web/Inngest treat the runner request as successful once the runner accepts it, not when a durable worker has claimed and completed it.

Relevant code:

- `apps/runner/src/server.ts`
- `apps/runner/src/agent-loop.ts`
- `apps/runner/src/run-control.ts`
- `apps/web/lib/inngest/functions.ts`
- `apps/web/lib/agent-sessions/message-runner.ts`
- `packages/db/src/schema.ts`

## Problem

If the runner process exits after returning `202` but before or during the unawaited promise, the trigger has already been acknowledged upstream. The existing run lease protects concurrent execution, but it does not guarantee delivery after runner process loss.

## Goal

Make session lifecycle work durable before acknowledging the caller.

## Suggested approach

Add an explicit runner jobs/outbox table, for example `agent_session_run_jobs`, with:

- `id`
- `sessionId`
- `messageId` or nullable action-specific reference
- `kind`: `start`, `message`, `title`, `after_session`
- `status`: `pending`, `running`, `completed`, `failed`
- `attempts`
- `nextRunAt`
- `leaseId`, `leaseOwner`, `leaseExpiresAt`
- `lastError`
- timestamps

Then change the internal runner endpoints so they only enqueue or upsert the durable job and return `202`. A runner-side worker loop should claim due jobs from Postgres and execute `startSession`, `runMessage`, etc. Keep existing run-control leases for session-level execution, but make the job row the delivery mechanism.

## Acceptance criteria

- A runner request is considered accepted only after a durable job row exists.
- A runner crash after `202` does not permanently strand a start/message/after-session request.
- Repeated direct and Inngest nudges are idempotent.
- Existing session event replay behavior remains unchanged.
- Tests cover enqueue idempotency, job claiming, crash/retry semantics, and duplicate message protection.

## Verification

Run:

```sh
bun --filter @opencompany/runner test
bun --filter @opencompany/web test
bun run typecheck
```
