# Client Sync — TanStack DB, ElectricSQL, Durable Streams

The web client's interactive data foundation is **TanStack DB** collections synced in
real time from Postgres by **ElectricSQL**, plus **Durable Streams** for the open
session transcript. Reads are reactive; writes stay on trusted server actions and
are reconciled by transaction id.

This replaces the previous TanStack Query + hand-rolled optimistic-cache layer for
agents and the sessions sidebar. Live agent streaming no longer uses the runner's
in-process SSE broker.

## How It Fits Together

```
WRITE                              READ (durable rows)            READ (live transcript)
component -> collection.update()   Neon --logical repl-->         runner/web append runtime events
  -> Server Action (db.batch)        Electric service               -> Durable Stream session-<id>
  -> returns txid                    -> /api/electric/v1/shape       -> /api/streams/v1/session/<id>
  -> collection.awaitTxId(txid)        (auth proxy, scoped)          -> reducer materializes UI
```

- **Durable list state** (`agents`, `agent_sessions`, `session_stars`) syncs out of
  Postgres via Electric. When the runner or web commits a row, subscribed clients
  receive it without a refetch.
- **Open-session transcript state** flows through a per-session Durable Stream named
  `session-<sessionId>`. The runner appends durable runtime events and transient
  token deltas; the web app also appends web-authored durable events such as user
  messages and optimistic abort status. Postgres remains the system of record.
- **No per-token DB writes:** high-frequency `message.delta`, `message.reasoning_delta`,
  and `command.output` events are stream-only. Durable message/event rows still land
  in Postgres at normal turn boundaries.

## Components

- **Electric auth proxy:** `apps/web/app/api/electric/v1/shape/route.ts`. The browser
  only requests shapes from this same-origin route. It authenticates with
  `currentWorkspace()`, validates the requested table against an allow-list, and
  sets `table`/`columns`/`where` server-side scoped to the caller's workspace/user.
  Clients cannot widen their own shape.
- **Collections:** `apps/web/lib/collections/`. `createCollections(workspaceId, userId)`
  builds the workspace-scoped collections. `CollectionsProvider` rebuilds them on
  workspace switch. Collections are inert until a live query subscribes.
- **Write reconciliation:** `apps/web/lib/db/txid.ts` `batchWithTxid(...)`. The
  neon-http driver has no interactive transactions, so mutations and
  `pg_current_xact_id()` run in one `db.batch([...])`; the returned `txid` lets
  collection write handlers know when Electric has synced the optimistic write back.
- **Durable Streams publisher:** `apps/runner/src/durable-streams.ts` publishes runner
  runtime events. `apps/web/lib/agent-sessions/durable-streams.ts` publishes the
  small set of web-authored transcript events.
- **Durable Streams read proxy:** `apps/web/app/api/streams/v1/session/[sessionId]/route.ts`.
  The browser reads through this same-origin proxy, never directly from the stream
  service. The proxy verifies session ownership and forwards only the validated
  `session-<id>` stream with the server-side token.
- **Transcript materialization:** `apps/web/lib/agent-sessions/session-stream.ts` and
  `apps/web/components/useSessionStream.ts` subscribe to the stream and fold events
  through `applyRuntimeEventToState`.

## Setup

1. **Neon logical replication.** Enable `wal_level = logical` on the Neon project and
   give Electric the **direct, non-pooled** connection string. Electric creates
   `electric_publication_default` and `electric_slot_default`. This is project-level,
   so it applies to every branch (including ephemeral local branches).
2. **Run Electric shape sync.** Self-host Electric or use Electric Cloud pointed at the
   Neon direct connection.

   **Local dev (automatic):** `bun run setup` starts a local `electricsql/electric`
   container in insecure mode, pointed at your Neon direct connection (derived from
   `DATABASE_URL` by stripping the `-pooler` label, same as the runner), and writes
   `ELECTRIC_URL=http://localhost:3010` to `.env.local`. A container runtime is
   required — install [OrbStack](https://orbstack.dev) (`brew install orbstack`) or
   Docker Desktop; setup fails fast with install instructions if it's missing or not
   running. The container is detached (`--restart unless-stopped`), so it
   survives dev restarts and reboots. Remove it with
   `docker rm -f opencompany-electric`. `bun run electric:dev` runs it in the
   foreground to tail logs / restart against a freshly rebranched database. Leave
   `ELECTRIC_SOURCE_ID`/`ELECTRIC_SOURCE_SECRET`/`ELECTRIC_TOKEN` empty — the dev
   service is unauthenticated and the proxy adds no upstream credentials.

   Port (`3010`) and container name (`opencompany-electric`) are overridable via
   `ELECTRIC_DEV_PORT` / `ELECTRIC_CONTAINER_NAME` if you run more than one workspace's
   Electric at once.
3. **Run Durable Streams.** No Docker needed — it's a pure-JS reference server.
   `bun run dev` starts a local Durable Streams server automatically (in-memory,
   `@durable-streams/server`) and injects `DURABLE_STREAMS_URL` into the web + runner
   dev processes, so transcripts stream with no extra setup. It reuses an
   already-running server on the port and steps aside if you set `DURABLE_STREAMS_URL`
   yourself. Run `bun scripts/durable-streams-dev.mjs` standalone only when running the
   apps outside `bun run dev`. Override host/port with `DURABLE_STREAMS_DEV_HOST` /
   `DURABLE_STREAMS_DEV_PORT` (default `127.0.0.1:4150`). Hosted environments should use
   the Electric Cloud Durable Streams base URL and token.
4. **Env** (`.env.example`):
   - `ELECTRIC_URL`, plus `ELECTRIC_SOURCE_ID` / `ELECTRIC_SOURCE_SECRET` for Electric
     Cloud, or `ELECTRIC_TOKEN` for a protected self-hosted service.
   - `DURABLE_STREAMS_URL` and `DURABLE_STREAMS_TOKEN` for the session transcript stream.

With `ELECTRIC_URL` empty, the shape proxy returns 503 and the agents/sessions UI has
no data source — the read layer is fully Electric-backed, so it does not degrade to a
usable state. Set `ELECTRIC_URL` (locally via `bun run electric:dev`) to use the app.
With `DURABLE_STREAMS_URL` empty, stream publishing is a no-op and the transcript proxy
returns 503; the rest of the app still works, only the live transcript stops updating.
`bun run dev` sets it automatically for local dev, so you only hit this when running the
apps outside `bun run dev` without starting `bun scripts/durable-streams-dev.mjs`.

**Owner:** Platform.

**Reconsider if:** sync requirements shrink to a single client per session, or grow to
need offline write queues.
