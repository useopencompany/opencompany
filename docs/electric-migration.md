# TanStack DB + ElectricSQL Migration

This records the completed migration of the web client's interactive data layer to
TanStack DB, ElectricSQL shape sync, and Durable Streams.

For the maintained architecture and setup guide, see
[`docs/stack/electric-sync.md`](./stack/electric-sync.md).

## Current Architecture

```
WRITE                              READ (durable rows)            READ (live transcript)
component -> collection.update()   Neon --logical repl-->         runner/web append runtime events
  -> Server Action (db.batch)        Electric service               -> Durable Stream session-<id>
  -> returns txid                    -> /api/electric/v1/shape       -> /api/streams/v1/session/<id>
  -> collection.awaitTxId(txid)        (auth proxy, scoped)          -> reducer materializes UI
```

- Agents, session list rows, and session stars sync from Postgres to TanStack DB
  collections through Electric.
- The open session transcript streams through a resumable Durable Stream. The runner
  appends runtime events; the web app appends web-authored events such as user messages
  and optimistic abort status.
- Postgres remains the system of record. High-frequency token, reasoning, and command
  output deltas are stream-only and are not written per token to Postgres.
- The old runner browser SSE endpoint, stream-token route, and runtime token helpers
  were removed.

## Key Files

| Area | Path |
|---|---|
| Electric auth proxy | `apps/web/app/api/electric/v1/shape/route.ts` |
| Workspace collections | `apps/web/lib/collections/index.ts` |
| Electric collection helper | `apps/web/lib/collections/electric.ts` |
| Raw row types | `apps/web/lib/collections/types.ts` |
| Selectors | `apps/web/lib/collections/selectors.ts` |
| Collections provider | `apps/web/components/CollectionsProvider.tsx` |
| Hydration gate | `apps/web/components/useHydrated.ts` |
| Write txid helper | `apps/web/lib/db/txid.ts` |
| Runner stream publisher | `apps/runner/src/durable-streams.ts` |
| Web stream publisher | `apps/web/lib/agent-sessions/durable-streams.ts` |
| Stream read proxy | `apps/web/app/api/streams/v1/session/[sessionId]/route.ts` |
| Stream consumer | `apps/web/lib/agent-sessions/session-stream.ts` |

## Implemented Surfaces

- **Agents:** `AgentsView` and `MainPanel` read from live collections. Delete is
  optimistic and reconciles by txid. Agent detail stays on the existing loader because
  it combines synced base row data with server-only GitHub/MCP domains.
- **Sidebar sessions + stars:** `agentSessions` and `sessionStars` collections drive
  the sidebar. Star and archive actions are optimistic and reconciled by txid.
- **Session detail + streaming:** `SessionView` materializes the transcript from the
  Durable Stream and merges it with the Postgres snapshot floor so durable rows never
  disappear if a best-effort stream append is missing.

## Operational Notes

- Electric needs Neon's direct non-pooled connection and logical replication enabled.
- Electric Cloud source credentials live in Infisical under the web env path.
- Durable Streams credentials must be available to both web and runner because web owns
  the authenticated read proxy and web-authored event appends, while runner owns model
  and tool event appends.
- Rotate any Electric source secret that was copied into chat during setup.
- Local Durable Streams testing can use `bun scripts/durable-streams-dev.mjs`.

## Later Improvements

- Persist or derive a recent Durable Stream offset to avoid replaying long historical
  token streams when the Postgres snapshot is already enough.
- Revisit whether agent detail should adopt a collection for the base row while keeping
  GitHub/MCP aggregates server-loaded.
- Add parser overrides if Electric timestamp or JSON coercion needs to move out of selectors.
