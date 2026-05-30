# M9 — Move append-only high-volume tables to bigint PKs

**Severity:** 🟡 Medium — latent foundation risk; cheap now, painful later.

> **Refactor, don't duct-tape.** Do the type migration properly (PK + all FKs +
> any cursor types). Don't "monitor the sequence and deal with it later" — that's
> deferring a guaranteed migration to a worse time.

## Root cause

The highest-volume, append-only tables use `serial` (int4, ~2.1B ceiling):

- `agent_session_events` — grows fastest; **its `id` is also the public SSE
  cursor** (`Last-Event-ID` / `after`). (`packages/db/src/schema.ts`,
  `agentSessionEvents = serial("id")`.)
- `agent_session_usage`, `agent_session_tool_usage` — one row per model step /
  tool call.
- `workspace_credit_ledger` — one row per billable event.

int4 is a real ceiling for an event log across all sessions over the product's
lifetime, and exhaustion mid-flight is an outage.

## The refactor

1. Migrate these PKs (and every FK that references them, e.g.
   `workspace_credit_ledger.model_usage_id` / `tool_usage_id`,
   `agent_session_events.message_id` references, etc.) to `bigint` /
   `bigserial` / `identity`.
2. Audit cursor and payload types end-to-end so nothing truncates a 64-bit id:
   - runner SSE id handling (`server.ts` `formatSseEvent`, `readLastEventId`)
   - client parsing (`useSessionEventStream.ts` `parseRuntimeEvent`,
     `runtime-events.ts` `RuntimeEvent.id: number`). JS `number` holds 2^53
     safely — fine for bigint in practice, but confirm no `parseInt`/int
     assumptions choke.
3. Generate and apply the migration via `bun run db:generate` / `db:migrate`.
   Plan for the table-rewrite cost (large tables) — schedule in the production
   release workflow accordingly.

## Files in scope

- `packages/db/src/schema.ts` + generated migration in `drizzle/`
- `apps/runner/src/server.ts`, `apps/runner/src/events.ts` (cursor types)
- `apps/web/components/useSessionEventStream.ts`,
  `apps/web/lib/agent-sessions/runtime-events.ts` (id types)
- `docs/database.md`

## Acceptance criteria

- All four tables use 64-bit ids; all referencing FKs updated.
- SSE cursor round-trips a value > 2^31 correctly end-to-end (add a test).
- Migration applies cleanly and is sized/scheduled for prod table volume.

## Risks / notes

- Do this while tables are still small — the rewrite is far cheaper now.
- Coordinate with H5 (which adds unique constraints to the usage tables) so both
  schema changes land in one coherent migration rather than two rewrites.
