# Instant App Refactor — TanStack DB + ElectricSQL

> The plan we set out at the start, plus a step-by-step checklist of what's done and what's
> left. This is the **entry point / handoff doc**. Deeper detail lives in
> [`docs/electric-migration.md`](docs/electric-migration.md) (living reference) and
> [`docs/stack/electric-sync.md`](docs/stack/electric-sync.md) (architecture writeup).

**Legend:** ✅ done · 🚧 in progress · ⬜ not started

---

## The plan (what we decided up front)

Rebuild the web client's data foundation so the app feels **near-instant and optimistic**:

- Every **read** becomes a reactive **live query** over a **TanStack DB** collection.
- Every **write** is **optimistic** (applied instantly) and **reconciled** against the server.
- Durable state syncs **Postgres → client in real time via ElectricSQL** (Electric Cloud).
- The custom **SSE stream is reduced to a pure transient-token channel** for live agent
  streaming (durable message/event rows now arrive via Electric).
- **No legacy support** — the old TanStack Query + hand-rolled optimistic-cache layer is
  deleted surface-by-surface as it migrates.

**Decisions locked in:** (1) full ElectricSQL now, not a future swap; (2) migrate the
interactive surfaces first (agents, sessions sidebar, session detail + streaming) and leave
brain files / integrations / tool policies / credit balance server-rendered; (3) streaming
tokens live in a `localOnly` collection unioned with the durable message row.

### Architecture

```
WRITE                              READ (durable rows)            READ (live tokens)
component → collection.update()    Neon ──logical repl──▶         runner ──SSE──▶ useSessionEventStream
  → on{Insert,Update,Delete}         Electric Cloud                 → transientDeltas (localOnly)
    → Server Action (db.batch)       → /api/electric/v1/shape       unioned w/ durable msg row
    → returns txid                     (auth proxy, per-ws scope)   in the transcript live query
  → awaitTxId(txid) reconciles
```

Electric syncs **raw snake_case rows**; camelCase derivation happens client-side in
**live-query selectors**. Collections are **normalized** (one per table). Writes stay on
**Server Actions** (Electric is read-path only) and reconcile by Postgres **txid**.

---

## Checklist

### Phase 0 — Foundation ✅
- ✅ Install `@tanstack/react-db` + `@tanstack/electric-db-collection`
- ✅ Auth proxy `apps/web/app/api/electric/v1/shape/route.ts` (per-workspace/user shape scoping, table allow-list)
- ✅ Collection factory `apps/web/lib/collections/` (`index.ts`, `electric.ts`, `types.ts`, `selectors.ts`)
- ✅ `CollectionsProvider` mounted in `AppShell`; rebuilds on workspace switch
- ✅ `useHydrated()` gate (`useLiveQuery` is client-only)
- ✅ `batchWithTxid()` write helper (`apps/web/lib/db/txid.ts`) — neon-http has no interactive txns
- ✅ Env + docs (`.env.example`, `docs/stack/electric-sync.md`)
- ✅ **Infra**: Neon `wal_level=logical` + Electric Cloud source provisioned and verified end-to-end

### Phase 1 — Agents 🚧
- ✅ **Reads**: `AgentsView` + `MainPanel` on `useLiveQuery` (live cross-tab updates confirmed)
- ✅ **Write — delete**: `deleteAgent` returns txid via `batchWithTxid`; agents collection `onDelete`;
  `AgentDetail` deletes via `agentsCollection.delete()` + optimistic navigate
  - ⬜ **Polish**: deleting still shows a ~1s spinner — investigate the pending UI gated on
    `tx.isPersisted.promise` (the row IS removed optimistically; the lingering spinner is the issue)
- ⬜ **Write — update**: `updateAgent` `onUpdate` handler. Its agents-row write already uses
  `db.batch`, so swap to `batchWithTxid` and reconstruct the patch from `mutation.changes`; wire
  `AgentDetail` save through `agentsCollection.update()`
- ⬜ **Write — create**: confirm `createAgent` flow (server redirect) lands the new row live (optional `awaitMatch` for instant-open)
- ⬜ Optional: promote `agentDetail` to a collection (still on React Query today)

### Phase 2 — Sidebar sessions + stars ⬜
- ⬜ `agentSessions` + `sessionStars` Electric collections (factory already stubs `agentSessions`/`sessionStars`)
- ⬜ Selectors: session row → `SidebarSessionPayload`; sidebar = live query joining sessions ⨝ stars
- ⬜ `Sidebar` → `useLiveQuery` (gated by `useHydrated`, SSR `initialSessions` as fallback)
- ⬜ Optimistic `setSessionStar` (insert/delete on `sessionStars`) + `archiveAgentSession` (update `archived_at`)
- ⬜ Delete legacy helpers: `upsertSidebarSession`, `removeSidebarSession`, `setSidebarSessionStar`,
  `archiveSidebarSessionOptimistically`, sidebar branch of `seedSessionQueries`

### Phase 3 — Session detail + streaming ⬜
- ⬜ Per-session `messages` + `events` collections via `createSessionCollections(sessionId)` (already stubbed)
- ⬜ Transcript = live query composing messages + events (+ usage) for the open session
- ⬜ `SessionView` top read → `useLiveQuery`
- ⬜ Rewrite `applyRuntimeEvent` to handle **transient events only** → `transientDeltas` localOnly collection
- ⬜ Union live query: durable message content ⊕ transient token buffer; clear buffer on `completed`
- ⬜ Optimistic `submitAgentSessionMessage` (insert user row) + `abortAgentSession` (status)
- ⬜ Remove SSE durable-reconnect/merge path; delete `seedSessionQueries`,
  `mergeAgentSessionDetail`, `applyRuntimeEventToSessionDetail`, `addUserMessageToSessionDetail`
  (keep the pure event→view derivations and `useSessionEventStream` as transient-only)

### Phase 4 — Cleanup + tests ⬜
- ⬜ Delete dead fetchers / query keys / `payload.ts` serializers no longer referenced
- ⬜ Update component tests (`Sidebar`, `SessionView`, `AgentDetail`) to drive collections
- ⬜ `bun run typecheck` + `bun run lint` + `bun run test` green

---

## Reference patterns (copy for each new surface)

**Read:** add collection → add `*RowTo*` selector → in the component split into presentational
`*Content` + client-only `*Live` (calls `useLiveQuery`) + default export gated on `useHydrated()`
that renders `*Content` from SSR props until hydrated.

**Write:** Server Action runs its row write + `pg_current_xact_id()` in one `db.batch` via
`batchWithTxid` → returns `{ ok, txid }`. Collection `on{Insert,Update,Delete}` applies the
optimistic change, calls the action, returns `{ txid }`; TanStack DB drops the overlay once
`awaitTxId` sees the txid (throw → auto-rollback). For multi-statement actions where the row
write can't be isolated into one batch, fall back to `collection.utils.awaitMatch(...)`.

## Gotchas
- `useLiveQuery` is **client-only** — always gate with `useHydrated()`.
- Shape URL must be **absolute** (`ShapeStream` does `new URL(url)`) — built from `window.location.origin`.
- **neon-http has no interactive transactions** — use `db.batch([write, SELECT pg_current_xact_id()])`. `awaitTxId` wants a **numeric** txid (`::xid` → `Number`).
- **HTTP/2 in dev**: plain-HTTP localhost caps ~6 connections/origin; each live shape holds one. Keep concurrent shapes low (only the open session syncs messages/events). Fine in prod over HTTPS.
- Proxy sets `table`/`columns`/`where` **server-side** from `currentWorkspace()` — never trust client params.
- **Rotate the Electric source secret** — it was pasted in chat during setup.

---

## ▶ Next step for a fresh session

Finish **Phase 1 writes**:
1. Add the agents collection **`onUpdate`** handler — refactor `updateAgent` to return a txid via
   `batchWithTxid` (its agents-row write already uses `db.batch`) and reconstruct the patch from
   `mutation.changes`; route `AgentDetail`'s save through `agentsCollection.update()`.
2. Fix the **delete ~1s spinner** (pending UI gated on `tx.isPersisted.promise`).

Then Phase 1 is the complete reference slice and Phase 2 (sidebar) replicates the pattern.
