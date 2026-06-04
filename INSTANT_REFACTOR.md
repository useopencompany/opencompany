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
- Durable CRUD state (agents, session list, stars) syncs **Postgres → client in real time via
  ElectricSQL** (Electric Cloud shape sync).
- The **live session transcript** streams over a **resumable Durable Stream** (Electric's
  streaming primitive) — **not** raw SSE and **not** through the DB hot path. See the
  [Streaming architecture v2](#streaming-architecture-v2--durable-streams) section below.
- **No legacy support** — the old TanStack Query + hand-rolled optimistic-cache layer is
  deleted surface-by-surface as it migrates.

**Decisions locked in:** (1) full ElectricSQL now, not a future swap; (2) migrate the
interactive surfaces first (agents, sessions sidebar, session detail + streaming) and leave
brain files / integrations / tool policies / credit balance server-rendered; (3) **[REVISED
after research — see v2 below]** the live transcript streams over a **Durable Stream**
(resumable, offset-based), not over raw SSE with a `localOnly` token buffer. Electric **shape
sync** stays for durable CRUD collections (agents, session list, stars); the **Durable Stream**
is the read path for the open session's transcript.

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

## Streaming architecture v2 — Durable Streams

> This supersedes the original Phase 3 design ("SSE reduced to transient-only + durable rows via
> Electric shapes"). We researched Electric's own AI-app guidance and pivoted. Decision locked in
> with the product owner: **adopt Durable Streams for the live session, pre-launch, as a deep
> refactor of both the web client and the runner.**

### Why we pivoted (the research)

Electric's explicit position for AI apps ([_Building AI apps? You need sync_](https://electric.ax/blog/2025/04/09/building-ai-apps-on-sync)):
**don't stream tokens directly to the UI over fragile SSE, and don't write per-token rows to the
DB.** Stream over a **resumable stream**; use the DB / Electric shape-sync for **durable CRUD
state**. They productised the streaming half as **[Durable Streams](https://electric.ax/blog/2025/12/09/announcing-durable-streams)** —
a persistent, append-only HTTP log with **offset-based resumption** (catch-up read from any
offset, then live tail), CDN-cacheable reads, "<15ms end-to-end". It's the transport under
Electric 2.0; **1.5 years in production, 10 language clients**. [Hosted on Electric
Cloud](https://electric.ax/blog/2026/01/22/announcing-hosted-durable-streams): `PUT
…/v1/stream/<service>/<name>` to create, **reads free, 5M writes/month free**, 240K writes/s.

The original plan's flaw against our north-star (**very fast + robust live streaming**): routing
durable event boundaries (tool-completed, message-completed) through Electric **shape** sync puts
logical-replication + shape-poll latency in the live path. Durable Streams removes that — the live
transcript (durable boundaries *and* token deltas) flows over one resumable stream, while Postgres
stays the system of record for the sidebar / billing / history.

It also fixes a **latent runner bug**: `apps/runner/src/events.ts` fans events over an **in-process
`EventEmitter`** (`sessionEventBroker`) → SSE. That only works when the SSE connection and the agent
run land on the **same runner instance**. A Durable Stream is a shared, addressable log — multi
instance-safe by construction.

### The two-plane model

```
PLANE A — durable CRUD state (Electric shape sync)      PLANE B — live transcript (Durable Stream)
agents · agent_sessions · session_stars                 per-session stream: stream/<svc>/session-<id>
Neon ──logical repl──▶ Electric Cloud ──▶ shapes        runner ──append (durable + transient events)──▶
  → workspace collections (sidebar, agents list)          Electric Cloud Durable Stream
  → already DONE in Phases 0–2                             → web: @durable-streams/client (resumable
                                                             from offset) → materialize via the
                                                             existing applyRuntimeEventToState reducer
                                                             → useLiveQuery transcript
```

- **Runner** keeps persisting durable rows to Postgres (system of record — feeds the sidebar via
  Plane A, plus billing/usage/history). It **additionally appends every event** (durable + transient)
  to the session's Durable Stream — replacing the in-process broker fan-out. Per-token deltas go to
  the **stream only**, never to Postgres → **no obsessive DB writes** (write volume to PG is
  unchanged; the stream is not the DB).
- **Web client** drops the raw-SSE `useSessionEventStream` + the HTTP detail-refetch/merge path.
  The transcript is materialized from the Durable Stream: read from the persisted offset (instant
  history, no fetch), live-tail the rest, fold through the **existing, battle-tested
  `applyRuntimeEventToState` reducer** into the rendered `AgentSessionDetailPayload`. Resumable
  across refresh / network drop / re-render; multi-tab and multi-device for free.
- **Per-session Electric message/event shapes are NOT needed** (the stub `createSessionCollections`
  is superseded) — the Durable Stream is the transcript read path. Electric shapes remain for Plane A.

### Materialization: reducer first, StreamDB maybe later

**[StreamDB](https://electric.ax/blog/2026/03/26/stream-db)** (`@durable-streams/state`) can route stream
events into TanStack DB collections by type and materialize them with `useLiveQuery`. It's the
elegant end-state — but it's **new (Mar 2026), docs sparse**. We will **first** consume the raw
stream with `@durable-streams/client` and fold events through our existing reducer (which already
handles deltas, tool calls, reasoning, questions, approvals, usage). That keeps the risk on the
**mature** transport and reuses tested logic. Adopt StreamDB only if it clearly simplifies.

### Keep the transport swappable / risk posture

- Build the consumer behind one seam (`useSessionStream`) so SSE → Durable Streams (and later →
  StreamDB) is a localized change. Land it **behind a flag**, keep SSE working until the stream
  round-trip is verified end-to-end, then delete SSE.
- **Maturity caveat:** Durable Streams *transport* is production-grade; **StreamDB and the hosted
  service are early** — this is a launch-critical path, so verify the round-trip (catch-up + live +
  resume-after-drop) before removing the SSE fallback.
- **Per-session aggregates** (usage/cost recursive CTE, parent/children `related`) stay on a
  lightweight server fetch that refetches on completion — not reproduced client-side, not on the
  live hot path (unchanged from the earlier D2 decision).

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

### Phase 3 — Session detail + streaming (Durable Streams refactor) 🚧 (flag-gated, awaiting live verification)

> **Revised** per [Streaming architecture v2](#streaming-architecture-v2--durable-streams). Spans the
> **runner** (`apps/runner`) + **web** (`apps/web`) + **infra** (Electric Cloud Durable Streams).
> Built behind `NEXT_PUBLIC_DURABLE_STREAMS` (off by default); SSE stays primary until the live
> round-trip is verified (3.5), then delete the legacy path (3.4). **Local dev needs no Electric
> Cloud** — `bun scripts/durable-streams-dev.mjs` runs a local stream server.

**3.0 — Infra + contract + scaffolding** ✅ (spike `e185e45`)
- ✅ Packages verified + installed (`@durable-streams/client` in web+runner, `@durable-streams/server`
  as dev). Architecture spike pinned the real client API (create w/ `contentType: application/json`;
  one JSON message per `append`; SSE read from offset `-1` replays history then tails; offset resume).
- ✅ Shared **stream contract**: stream name `session-<sessionId>`, framing = `RuntimeEventForStream`
  JSON (durable rows numeric `id`, transient `id: null`). Same-origin **read proxy**
  `app/api/streams/v1/session/[sessionId]/route.ts` (ownership-checked, server-side token, streaming
  passthrough). Env in `.env.example`; `scripts/durable-streams-dev.mjs` for local dev.
- ⬜ **Infra ask (prod only):** provision the hosted Durable Streams service + token on Electric Cloud.

**3.1 — Runner: append to the Durable Stream** ✅ (`dda3e07`)
- ✅ `publishRuntimeEvent` (the single fan-out for durable + transient events) also appends to
  `session-<id>` via a per-session `IdempotentProducer` (batched ~5ms, ordered, exactly-once,
  `autoClaim` for restarts). Additive + flag-gated; Postgres writes unchanged (system of record).

**3.2 — Web: consume the stream + materialize + cut over** ✅ (`c3bfdc3`, `23c18f4`, this commit)
- ✅ `subscribeSessionStream` / `useSessionStream`: one SSE read from offset `-1` replays history +
  live-tails (no handoff gap), folded through the **existing `applyRuntimeEventToState` reducer**.
- ✅ `SessionView` cutover (flag-gated): `runtime` (already the `SessionRuntimeState` shape) sources
  from the stream when on, with the server snapshot as the instant-paint fallback; raw-SSE
  `useSessionEventStream` disabled (null runner URL). Aggregates stay server-sourced (D2).
- ⬜ Resumability polish: catch-up replays from `-1` (rebuilds in-flight text on refresh — the win);
  a later pass can persist the offset / seed from the durable snapshot to avoid replaying all deltas.

**3.3 — Writes reach the stream** ✅ (this commit)
- ✅ Web-written durable events (the runner never re-emits them) now append to the stream:
  `insertUserMessage` mirrors the user `message.created` (real event id via `.returning()`);
  `abortAgentSession` emits an optimistic `session.status: aborting`. Best-effort + flag-gated via
  `lib/agent-sessions/durable-streams.ts` (lazy stream create). Client optimistic-echo overlay
  deferred — the append→SSE round-trip is fast; revisit if the echo feels laggy in the live test.

**Live verified ✅** against the real Electric Cloud service: end-to-end token streaming works in the
browser. Required a read-proxy fix (`9dbb22c`) — the Next route handler buffered the live SSE
(catch-up flushed, small live writes didn't); fixed with `force-dynamic` + no-store + full header
relay + `accept-encoding: identity`. The runner publisher + live SSE were validated node-direct first.

**Loose ends the cutover introduced** (the legacy path was masking these — fix them *during* 3.4 so the
new path is correct, not just working):
- ⬜ **Aggregates stale post-completion**: `runtime` takes usage/cost/toolUsage from the React-Query
  `detail`, but with SSE off nothing invalidates that query when a turn ends → the inspector's
  cost/usage won't refresh until reload. Fix: refetch `detail` when `streamState.currentStatus` reaches
  a terminal state (or source aggregates from the stream reducer for childless sessions).
- ⬜ **Inert SSE machinery when flag-on**: `applyRuntimeEvent`, `knownEventIds`, the stream-credential
  query + token refresh, the `stream.status` staleness/recovery, and TTFT (`pendingTtftRef` never
  clears → no `session_first_token` event). 3.4 deletes all of this; re-home TTFT onto the stream.

**3.5 — Verify the resilience wins** (the gate before deleting the fallback)
- ✅ Token stream instant; tool/message boundaries instant (no replication lag).
- ⬜ Refresh mid-generation resumes from offset without losing in-flight text (the resumability win).
- ⬜ Second tab mirrors live (multi-client).
- ⬜ Abort shows "aborting" immediately. Only after these → 3.4.

**3.4 — Remove the legacy streaming path** (after 3.5)
- ⬜ Delete raw-SSE `useSessionEventStream` (EventSource) + the stream-token credential flow; delete
  `seedSessionQueries`, `mergeAgentSessionDetail`, `applyRuntimeEventToSessionDetail`,
  `addUserMessageToSessionDetail`, `updateSessionStatusInDetail`. Keep the **pure event→view
  derivations** (`buildAssistantTurnParts`, etc.) and the reducer. Simplify the `detail` query's
  `queryFn` to a plain fetch (no merge); keep it for session meta + related + aggregates.
- ⬜ Drop the stubbed per-session Electric collections (`createSessionCollections`, `transientDeltas`)
  + their row types — superseded by the Durable Stream. Remove the
  `agent_session_messages`/`agent_session_events` scopes from the Electric shape proxy.
- ⬜ Delete the **Phase-2-deferred** sidebar helpers + the **Phase-1** vestigial `agentQueryKeys.list`.
- ⬜ Then **remove the `NEXT_PUBLIC_DURABLE_STREAMS` flag** — Durable Streams becomes the only path.

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
- **HTTP/2 in dev**: plain-HTTP localhost caps ~6 connections/origin; each live shape holds one. Keep concurrent shapes low. With Durable Streams (Plane B) the open session no longer holds per-session message/event *shapes* — it holds **one** resumable stream connection instead, easing the cap.
- Proxy sets `table`/`columns`/`where` **server-side** from `currentWorkspace()` — never trust client params. Mirror this for the Durable Stream read proxy (verify session ownership; keep the write token server-side).
- **Rotate the Electric source secret** — it was pasted in chat during setup. (Same discipline for the Durable Streams write token: server-side only.)
- **Durable Streams maturity**: transport is production-grade; **StreamDB + hosted service are early (2026)** — verify the live round-trip before deleting the SSE fallback.
- **Runner broker is in-process** (`EventEmitter`): today's SSE only works on the same instance as the run. Durable Streams fixes this; don't reintroduce in-process fan-out as the client transport.

---

## ▶ Next step for a fresh session

Phases 1–2 done. Phase 3 (Durable Streams) is **built and live-verified for streaming** — the runner
publishes, the web materializes via the reducer, and token streaming works end-to-end against the real
Electric Cloud service (behind `NEXT_PUBLIC_DURABLE_STREAMS`, off by default; SSE still primary).

**The path to "clean refactor done", in order:**

1. **Verify the resilience trio (3.5 gate — human, ~5 min):** refresh mid-generation (in-flight text
   survives), second tab mirrors live, abort shows instantly. These justify the architecture and gate
   removing the fallback.
2. **3.4 — delete the legacy SSE path** as a focused pass on `SessionView` + `payload.ts` + `collections/`
   + the Electric proxy. Fix the two cutover loose ends *here* (aggregates refetch on completion; re-home
   TTFT) since the legacy machinery currently masks them. This makes the open session single-path.
3. **Remove the `NEXT_PUBLIC_DURABLE_STREAMS` flag** — Durable Streams becomes the only path.
4. **Phase 4 — tests + dead-code sweep:** a `SessionView` component test driving a mocked stream;
   delete the Phase-2-deferred sidebar helpers, `agentQueryKeys.list`, and dead `payload.ts` serializers.

**Post-clean polish (non-blocking):** client optimistic-echo overlay for the user bubble; persist the
offset / seed from the durable snapshot so long sessions don't replay every token delta on load; wire
`flushSessionStream`/`closeSessionStream` into the runner's session lifecycle (mind the flush race).

**Standing security item:** rotate the Durable Streams token (pasted in chat during setup).
