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

### Phase 1 — Agents ✅
- ✅ **Reads**: `AgentsView` + `MainPanel` on `useLiveQuery` (live cross-tab updates confirmed)
- ✅ **Write — delete**: `deleteAgent` returns txid via `batchWithTxid`; agents collection `onDelete`;
  `AgentDetail` deletes via `agentsCollection.delete()` + optimistic navigate
  - ✅ **Spinner fixed**: the ~1s spinner was `router.push` running *inside* the same transition that
    awaited `tx.isPersisted.promise` — React deferred the navigation commit until reconciliation
    settled. Now the optimistic delete + navigate are synchronous and reconciliation runs in a
    detached `.catch` (rollback + toast on failure). Delete is instant.
- ✅ **Write — update**: kept on the existing `updateAgent` server action (+ `revalidatePath`); the
  agents list reflects edits via Electric sync. **Decision:** no agents `onUpdate` overlay — the
  detail view stays React-Query-backed (below), so an overlay's txid would be unused, and the edit's
  semantic patch (`{name,body,model,config}` — `model` lives in `config.model.name`) doesn't map
  cleanly onto raw-row column mutations. The optimistic-write *reference pattern* is established on
  the sidebar (Phase 2) instead, where it's clean and actually matters.
- ✅ **Decision — `agentDetail` stays on React Query**, not promoted to a collection. Its aggregate
  straddles synced data (the base row) and **server-only domains intentionally out of scope** (MCP
  settings, GitHub integration repo catalogs). Promotion would fight decision #2. `AgentDetail`
  already feels optimistic locally (`saveState`, `optimisticGitHubSync`, local field state).
- ⬜ Phase 4 cleanup: `updateAgentQueries`' `agentQueryKeys.list` seeding + the back-link list
  prefetch are now vestigial (AgentsView/MainPanel read the collection, not that cache). Harmless;
  remove with the other dead React-Query plumbing in Phase 4.

### Phase 2 — Sidebar sessions + stars ✅ (helper deletion deferred to Phase 4)
- ✅ `agentSessions` + `sessionStars` Electric collections wired with write handlers
- ✅ Selector `deriveSidebarSessions(sessions, stars)` joins the two collections → `SidebarSessionPayload`,
  excludes `status IN ('archiving','archived')`, mirrors the SSR recency window (top-50 ∪ all pinned)
- ✅ `Sidebar` split into `SidebarContent` (presentational) / `SidebarLive` (`useLiveQuery` ×2 + handlers)
  / default export gated on `useHydrated` (SSR `initialSessions` as the pre-hydration fallback)
- ✅ Optimistic **star**: `sessionStars.insert/delete`; `setSessionStar` returns txid via `batchWithTxid`
- ✅ Optimistic **archive**: `agentSessions.delete()` → `onDelete` → `archiveAgentSession`. **Flicker-free**
  via txid: `archiveAgentSession` returns the txid of the synchronous write it controls — `archived_at`
  on the local (no-sandbox) path, `status='archiving'` on the runner path — so the optimistic overlay
  holds until Electric streams *that* transaction, after which the status-excluding selector keeps the
  row hidden until `archived_at` finally lands. `WorkspaceContext` now also carries `userId` (needed to
  build optimistic `session_stars` rows).
- ⬜ **Deferred to Phase 4**: delete legacy helpers `upsertSidebarSession`, `removeSidebarSession`,
  `setSidebarSessionStar`, `archiveSidebarSessionOptimistically`, `fetchSidebarSessions`,
  `sessionQueryKeys.list`, and the sidebar branch of `seedSessionQueries`. They're dead (the sidebar no
  longer reads React Query) but harmless, and unwinding `seedSessionQueries` is entangled with Phase 3's
  session-detail rewrite + the large `payload.test.ts`. Clean up wholesale in Phase 3/4.

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

Phases 1 (agents) and 2 (sidebar) are done; the optimistic-write reference pattern is proven on the
sidebar (star = txid-reconciled insert/delete; archive = txid-reconciled soft delete + status-excluding
selector). Next is **Phase 3 — session detail + streaming** (the hardest, highest-value slice):

1. Per-session `messages` + `events` collections via `createSessionCollections(sessionId)` (stubbed;
   only the open session syncs — mind the HTTP/2 dev cap, keep concurrent shapes low).
2. Transcript = live query composing messages + events (+ usage) for the open session; `SessionView`
   top read → `useLiveQuery` (gated by `useHydrated`).
3. Rewrite `applyRuntimeEvent` to handle **transient events only** → `transientDeltas` localOnly
   collection; union live query (durable message content ⊕ transient token buffer; clear on `completed`).
4. Optimistic `submitAgentSessionMessage` (insert user row) + `abortAgentSession` (status).
5. Remove the SSE durable-reconnect/merge path; delete `seedSessionQueries`, `mergeAgentSessionDetail`,
   `applyRuntimeEventToSessionDetail`, `addUserMessageToSessionDetail` — and at that point also delete
   the Phase-2-deferred legacy sidebar helpers + the Phase-1 vestigial `agentQueryKeys.list` plumbing.
