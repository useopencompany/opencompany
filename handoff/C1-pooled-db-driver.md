# C1 — Give the runner a pooled DB driver with real transactions

**Severity:** 🔴 Critical — this is the highest-leverage change in the review and
unblocks C2, H6, and part of H5.

> **Refactor, don't duct-tape.** The fix is a new database driver path for the
> long-lived runner, not micro-optimizing individual queries. Do not "reduce the
> number of queries" as a substitute for fixing the transport. Do not add a
> query cache to hide round-trip cost. Replace the transport.

## Root cause

`packages/db/src/client.ts` exposes exactly one client, built on
`drizzle-orm/neon-http` + `neon()`:

```ts
import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
```

The `neon-http` driver issues **one HTTPS request per query**. There is no
connection pool, no persistent socket, no statement pipelining, and **no
interactive transactions** (only `db.batch()` non-interactive batches).

That is correct for the Vercel web app (serverless, one DB touch per request).
It is wrong for `apps/runner`, which is a persistent Fastify/Bun process
(`apps/runner/src/index.ts`) that streams for minutes and issues many queries
per turn. Every query pays a fresh HTTP round-trip, and the absence of
transactions is *why* the lease layer is written as racy check-then-write
(see H6).

## Symptoms downstream (do not fix these in isolation)

- C2: per-token `loadState` reads are HTTP requests.
- H6: lease guards can't be atomic because there are no transactions.
- General: every durable event write is 2 HTTP round-trips.

## The refactor

1. Add a **second, pooled** Drizzle client for long-lived services. Options, in
   order of preference:
   - `drizzle-orm/neon-serverless` with a `Pool` (WebSocket) — stays on Neon SDK.
   - `drizzle-orm/node-postgres` with a `pg.Pool` pointed at the Neon **pooler**
     endpoint (`-pooler` host).
2. Keep `neon-http` as the default export for the web app. Do **not** force web
   onto the pooled client.
3. Expose the pooled client explicitly, e.g. `getPooledDb()` /
   `createPooledDb(databaseUrl)`, and switch the runner's `getDb()` usage to it.
   Prefer making the runner import a runner-specific client module so the choice
   is obvious and can't leak into web.
4. Size and configure the pool deliberately (max connections vs. worker
   concurrency in `jobs.ts`, idle timeout, statement timeout). Document the math
   in `docs/database.md`.
5. Ensure graceful shutdown drains the pool in `apps/runner/src/index.ts`
   alongside the existing `jobWorker.stop()` / `server.close()`.
6. Introduce a real `db.transaction(...)` helper now that it's available — H6
   depends on this.

## Files in scope

- `packages/db/src/client.ts` (add pooled client)
- `apps/runner/src/index.ts` (lifecycle/shutdown)
- Everything in `apps/runner/src` that calls `getDb()` — route to the pooled
  client (consider a single runner DB module).
- `docs/database.md`, `docs/runner.md`

## Acceptance criteria

- Runner uses a pooled, persistent connection; web still uses `neon-http`.
- `db.transaction()` works in the runner and is used by at least one call path
  (coordinate with H6).
- Pool is configured against Neon's pooler with documented sizing, and drains on
  SIGTERM/SIGINT without dropping in-flight work.
- A load test of a single streaming turn shows a large drop in DB request count
  and measurable TTFB/inter-token latency improvement vs. baseline (capture
  before/after numbers in the PR).

## Risks / notes

- Neon pooler is PgBouncer in transaction mode — verify no reliance on
  session-level features (e.g. `SET`, advisory-lock-across-statements). The job
  queue's `FOR UPDATE SKIP LOCKED` works fine in transaction pooling **inside a
  transaction**.
- Watch connection budget: `instances × pool.max` must stay under Neon's limit.
