# H5 — Make usage/billing idempotent across run retries

**Severity:** 🟠 High — revenue integrity; can double-charge workspaces.

> **Refactor, don't duct-tape.** Do not "fix" this by disabling retries, or by
> trying to detect retries in application code and skipping recording. The
> correct fix is a deterministic idempotency key enforced by the database so that
> re-recording the same logical step is a no-op regardless of how many times the
> turn re-runs.

## Root cause

Message jobs retry up to 5 times (`apps/runner/src/jobs.ts:22`,
`RUNNER_JOB_MAX_ATTEMPTS`). A retried message **re-streams the model from
scratch** — `runMessageWithContext` reuses the assistant message id when an
incomplete response exists, then calls `streamText` again, producing fresh steps.

`recordStepUsage` (`apps/runner/src/usage-recorder.ts:62-86`) inserts a new
`agent_session_usage` row per step. There is **no unique constraint** on
`(session_id, message_id, step_index)` — the schema indexes for
`agentSessionUsage` are all non-unique. Each fresh usage row gets a fresh `id`,
which then drives a fresh ledger debit via `recordWorkspaceUsageDebit`.

The ledger's idempotency guard is a partial unique index on `model_usage_id` /
`tool_usage_id` (`packages/db/src/schema.ts`, `workspace_credit_ledger`), but that
only dedupes against *the same usage row id*. It does nothing when a retry
creates a *new* usage row. So a turn that records several steps and is then
retried bills the workspace twice for the redone steps.

Secondary issue: the balance check `hasPositiveWorkspaceBalance` runs **only at
the top of a turn** (`apps/runner/src/agent-loop.ts:218`). There is no mid-run
spend ceiling, so a single 16-step turn can drive a balance arbitrarily negative.

## The refactor

1. Add a **deterministic idempotency key** for model-step usage. Natural key:
   `(session_id, message_id, step_index)` — or a generated key like
   `usage:<messageId>:<stepIndex>`. Enforce with a unique constraint and write
   with `ON CONFLICT DO NOTHING ... RETURNING`. A re-streamed step must resolve to
   the **same** usage row, so the existing ledger unique index then correctly
   prevents a second debit.
2. Do the same for tool usage. A retried tool call should map to a stable key
   (e.g. `(session_id, message_id, tool_call_id, provider, operation)` or a
   provider request id when available) so re-execution doesn't double-charge.
3. Make usage-row insert + ledger debit happen in **one transaction** (depends on
   C1) so you can't record usage without the matching ledger entry (or vice
   versa) on a crash between them. Today they are two separate non-transactional
   statements.
4. Add a **mid-run balance guard**: re-check balance at step boundaries (or
   enforce a per-turn spend cap) and stop the turn cleanly when exhausted, rather
   than only gating at turn start.

## Files in scope

- `packages/db/src/schema.ts` (unique constraints on
  `agent_session_usage` and `agent_session_tool_usage`) + a Drizzle migration
  (`bun run db:generate` / `db:migrate`)
- `apps/runner/src/usage-recorder.ts` (`recordStepUsage`, `recordToolUsage` →
  conflict-aware writes + transaction)
- `packages/billing/src/index.ts` (`recordWorkspaceUsageDebit` already atomic;
  ensure the new keys flow through)
- `apps/runner/src/agent-loop.ts` (mid-run balance guard)

## Acceptance criteria

- Re-running a turn that already recorded steps 0..k inserts **zero** new usage
  rows and **zero** new ledger debits for those steps (test: run, abort after a
  few steps via lease loss, retry, assert ledger total unchanged for redone
  steps).
- Usage row + ledger debit are written atomically; a simulated crash between them
  leaves a consistent state.
- A workspace can't be driven arbitrarily negative within a single turn.
- Backfill plan / migration handles existing duplicate rows if any are found
  (audit first).

## Risks / notes

- Migration must add the unique constraint safely on a table that may already
  contain duplicates — dedupe/audit before adding the constraint.
- Keep idempotency keys deterministic from inputs the runner already has; do not
  invent random ids that won't be stable across retries.
