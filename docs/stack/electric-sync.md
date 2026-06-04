# Client Sync — TanStack DB + ElectricSQL

The web client's data foundation is **TanStack DB** collections synced in real time
from Postgres by **ElectricSQL**. Reads are reactive live queries; writes are optimistic
and reconciled by transaction id. This replaces the previous TanStack Query + hand-rolled
optimistic-cache layer for the interactive surfaces (agents, sessions sidebar, session
detail). Live agent token streaming stays on the runner SSE channel (see below).

## How it fits together

```
WRITE                              READ (durable rows)            READ (live tokens)
component → collection.update()    Neon ──logical repl──▶         runner ──SSE──▶ useSessionEventStream
  → onUpdate handler → Server       Electric service               → transientDeltas (localOnly collection)
    Action (db.batch) → txid        → /api/electric/v1/shape       unioned with the durable message row
  → collection.awaitTxId(txid)        (auth proxy, per-ws scope)   in the transcript live query
```

- **Durable state** (agents, agent_sessions, agent_session_messages, agent_session_events,
  session_stars) syncs out of Postgres via Electric. When the runner commits a row, every
  subscribed client receives it — no SSE refetch needed.
- **Transient tokens** (`message.delta`, `message.reasoning_delta`, `command.output`) are
  never persisted, so Electric can't carry them. They keep flowing over the runner SSE
  stream into a `localOnly` `transientDeltas` collection, unioned with the durable message
  row at render time. Cleared when the durable row reaches `completed`.

## Components

- **Auth proxy:** `apps/web/app/api/electric/v1/shape/route.ts`. The browser only ever
  requests shapes from this same-origin route. It authenticates via `currentWorkspace()`,
  validates the requested table against an allow-list, and sets `table`/`columns`/`where`
  **server-side** scoped to the caller's `workspace_id`/`user_id` (and verifies session
  ownership for per-session shapes). Clients cannot widen their own shape.
- **Collections:** `apps/web/lib/collections/` — `createCollections(workspaceId)` builds the
  workspace-scoped collections; `createSessionCollections(workspaceId, sessionId)` builds the
  per-open-session message/event collections. `CollectionsProvider` rebuilds them on workspace
  switch. Collections are inert until a live query subscribes.
- **Write reconciliation:** `apps/web/lib/db/txid.ts` `batchWithTxid(...)`. The neon-http
  driver has no interactive transactions, so mutations + `pg_current_xact_id()` run in one
  `db.batch([...])`; the returned `txid` is what the collection's `onUpdate/onInsert/onDelete`
  handler returns so `awaitTxId` knows when the optimistic write has synced back.

## Setup (operational — required before sync works)

1. **Neon logical replication.** Enable `wal_level = logical` on the Neon project and use the
   **direct (non-pooled)** connection string for Electric. Electric creates
   `electric_publication_default` + `electric_slot_default`. See
   https://neon.com/guides/electric-sql.
2. **Run the Electric service.** Self-host (Docker) or use Electric Cloud, pointed at the Neon
   direct connection. It needs a persistent TCP connection to Postgres. See
   https://electric.ax/docs/guides/deployment.
3. **Env** (`.env.example`): set `ELECTRIC_URL` (and `ELECTRIC_SOURCE_ID` / `ELECTRIC_SOURCE_SECRET`
   for Cloud, or `ELECTRIC_TOKEN` for a self-hosted service behind auth). With `ELECTRIC_URL`
   empty the proxy returns 503 and the app still boots (nothing subscribes).

**Owner:** Platform.

**Reconsider if:** sync requirements shrink to a single client per session (SSE alone would do)
or grow to need offline write queues (would pull in a through-the-DB write pattern / PGlite).
