# Refactor: TanStack DB + ElectricSQL — Living Reference

The rebuild of the web client's data foundation onto **TanStack DB** collections synced
in real time from Postgres by **ElectricSQL**. Goal: every read is a reactive live query;
every write is optimistic and reconciled. This is the source-of-truth roadmap — see
`docs/stack/electric-sync.md` for the architecture-component writeup.

**Status legend:** ✅ done · 🚧 in progress · ⬜ not started

---

## North star

- **Instant, optimistic feel** across the interactive surfaces.
- Durable state syncs Postgres → client via Electric. SSE is reduced to a pure **transient
  token** channel for live agent streaming.
- No legacy support — the old TanStack Query + hand-rolled optimistic-cache layer is deleted
  as each surface migrates.

## Scope (this effort)

In: agents (list/detail), sessions sidebar, session detail + streaming.
Out (stay server-rendered, Server Actions + `revalidatePath`): brain files, integrations,
tool policies, credit balance. Revisit later.

---

## Architecture (the shape)

```
WRITE                              READ (durable rows)            READ (live tokens)
component → collection.update()    Neon ──logical repl──▶         runner ──SSE──▶ useSessionEventStream
  → onUpdate handler → Server        Electric Cloud                 → transientDeltas (localOnly)
    Action (db.batch) → txid         → /api/electric/v1/shape       unioned w/ durable msg row
  → awaitTxId(txid) reconciles         (auth proxy, per-ws scope)   in the transcript live query
```

- Electric syncs **raw snake_case rows**; the camelCase payload derivation that used to be
  server-side now happens in **live-query selectors** (`lib/collections/selectors.ts`).
- Collections are **normalized** (one per table), composed by live queries.
- Writes stay on **Server Actions** (Electric is read-path only); reconciled by Postgres `txid`.

## Decisions locked in

1. **Full ElectricSQL now** (Electric Cloud, source `svc-fiscal-weasel-…`), not a future swap.
2. **Interactive surfaces first**; server-rendered domains stay as-is.
3. **Streaming tokens → `localOnly` collection** unioned with the durable message row.

---

## Key files

| Area | Path |
|---|---|
| Auth proxy | `apps/web/app/api/electric/v1/shape/route.ts` |
| Collection factory | `apps/web/lib/collections/index.ts` |
| Electric helper (abs URL, write handlers) | `apps/web/lib/collections/electric.ts` |
| Raw row types | `apps/web/lib/collections/types.ts` |
| Selectors (row → payload) | `apps/web/lib/collections/selectors.ts` |
| Provider | `apps/web/components/CollectionsProvider.tsx` |
| Hydration gate | `apps/web/components/useHydrated.ts` |
| Write txid helper | `apps/web/lib/db/txid.ts` |
| Setup / env | `.env.example`, `docs/stack/electric-sync.md` |

---

## Reference patterns (copy these for each new surface)

### Read (proven on agents)
1. Add a collection in `createCollections()` (or `createSessionCollections()` for per-session).
2. Add a `*RowTo*` selector mapping the raw row → existing payload type.
3. In the component, **gate `useLiveQuery` behind `useHydrated()`** — split into a presentational
   `*Content`, a client-only `*Live` (calls `useLiveQuery`), and a default export that renders
   `*Content` with SSR props until hydrated. Keep SSR/initial data as the pre-hydration fallback.

### Write (in progress on agents)
- Server Action runs its row write + `pg_current_xact_id()` in one `db.batch([...])` via
  `batchWithTxid(...)` and returns `{ ok: true, txid }`.
- Collection handler (`onUpdate`/`onInsert`/`onDelete`) applies the optimistic change, calls the
  action, returns `{ txid }`. TanStack DB drops the optimistic overlay once `awaitTxId` sees that
  txid in the shape stream; throws → auto-rollback.
- For large multi-statement actions where the row write can't be cleanly isolated into one batch,
  fall back to `collection.utils.awaitMatch(...)` (match the synced row) instead of txid.

---

## Gotchas (learned the hard way)

- **`useLiveQuery` is client-only** — no server snapshot; gate with `useHydrated()`.
- **Shape URL must be absolute** — `ShapeStream` does `new URL(url)`; build from
  `window.location.origin`.
- **neon-http has no interactive transactions** — use `db.batch([write, SELECT pg_current_xact_id()])`
  for an atomic write + txid (`batchWithTxid`). `sql` imports from `drizzle-orm`, not `@opencompany/db`.
- **HTTP/2 in dev** — plain-HTTP localhost caps ~6 connections/origin under HTTP/1.1; each live shape
  holds one. Keep concurrent shapes low (only the open session syncs messages/events). Resolves in
  prod over HTTPS. Watch for app freezes if shape count grows.
- **Shape auth** — the proxy sets `table`/`columns`/`where` server-side from `currentWorkspace()`;
  never trust client params. Per-session shapes verify session ownership before scoping.
- **Rotate the Electric source secret** — it was pasted in chat during setup.

---

## Phase status

- ✅ **Phase 0 — Foundation**: packages, auth proxy, collection factory + provider, txid helper,
  env + docs. Electric Cloud + Neon logical replication verified.
- 🚧 **Phase 1 — Agents**:
  - ✅ Reads: `AgentsView` + `MainPanel` on `useLiveQuery` (live cross-tab updates confirmed).
  - 🚧 Writes: optimistic **delete** done — `deleteAgent` returns numeric txid via `batchWithTxid`;
    agents collection `onDelete`; `AgentDetail` deletes via `collection.delete()` + `tx.isPersisted`.
    ⬜ `updateAgent` `onUpdate` next (its agents-row write already uses `db.batch`, so swap to
    `batchWithTxid` and reconstruct the patch from `mutation.changes`).
  - ⬜ Optionally promote `agentDetail` to a collection (currently still on React Query).
  - Note: Electric's `awaitTxId` wants a **numeric** txid (`number`), hence `::xid` (32-bit) →
    `Number(...)` in `batchWithTxid`. Delete degrades gracefully even if a txid match is missed
    (row is already gone optimistically + via synced delete).
- ⬜ **Phase 2 — Sidebar sessions + stars**: `agentSessions` + `sessionStars` collections; star/archive
  optimistic handlers; delete sidebar optimistic helpers from `payload.ts`.
- ⬜ **Phase 3 — Session detail + streaming**: per-session `messages`/`events` collections; transcript
  live query; SSE → transient-only into `transientDeltas`; remove SSE durable-reconnect/merge path;
  delete `seedSessionQueries`/`mergeAgentSessionDetail`/`applyRuntimeEventToSessionDetail`.
- ⬜ **Phase 4 — Cleanup + tests**: delete dead fetchers/query-keys/serializers; update component tests
  to drive collections.

## Verification per surface

Reads: list renders from SSR then live; two-tab edit propagates < ~1s; one streaming
`/api/electric/v1/shape` request per active shape (200).
Writes (once added): optimistic change is instant; forced action failure rolls back; no duplicate
rows after the synced row arrives.
Streaming (Phase 3): user bubble instant; first token ends TTFT; completion swaps the transient
buffer for the durable row with no flicker; reconnect catches up without truncation.

## Open questions / later

- Promote `agentDetail` to a collection, or keep its rich aggregate (bundle files, GitHub repos,
  mcp) on the existing loader and only sync the base row?
- SSR seeding: currently we render SSR props until hydrate, then the live query takes over. Consider
  seeding collections via `utils.writeUpsert` to skip the first client sync round-trip.
- ElectricSQL `parser` config if any timestamp/JSON column needs non-default coercion (today
  timestamptz arrives as a string — selectors handle it).
