# Goat Brain Retrieval (v2 design)

Rework of the read plane. The consumer of retrieval is an **agent in a tool loop** — every design
choice below follows from that. Agents reformulate queries themselves, read snippets before
acting, and chain point reads; the retrieval layer's job is to be *fast, cheap, and predictable*,
not clever. This replaces the plane-1 mechanics of the previous version of this doc; plane 2 (the
librarian) and per-brain addressing are unchanged and summarized at the end.

## Why rework: cost anatomy of one read today

Every consumer (chat `goat_brain` tool, MCP `query_brain`, ingestion agent) reads the brain the
same way (`apps/goat/lib/brain-cli.ts`, `apps/runner/src/goat-brain-agent-ingest.ts`):

| Step | Cost | Notes |
| --- | --- | --- |
| Materialize brain to temp dir | read ALL `goat.brain_documents` rows, write 2 files per doc + CLI bundle | per call |
| Spawn Node CLI | ~100–300ms | per call |
| `buildCorpus`: re-parse + re-validate every file | O(N) | per call |
| Build MiniSearch index in-memory | O(N) | per call |
| Query expansion (chat LLM call, 3 rewrites) | ~0.5–1.5s | per query |
| Embed **entire corpus** | O(N) tokens, ~1–5s | cache lives in the temp dir → always cold in the web path |
| LLM rerank of top 20 (chat call, JSON id array) | ~0.5–2s | fragile parse, discards scores |
| Delete temp dir | — | embedding cache thrown away |

A single `query` costs ~3–9s and O(corpus) embedding tokens. `get` — reading **one page** —
also materializes the whole brain and spawns the CLI (~0.5–1.5s to read one row). Meanwhile the
DB already stores everything retrieval needs, precomputed at write time: parsed columns on
`goat.brain_documents` (title, body, timeline, relations, aliases, kind, type, status,
contentHash), `goat.brain_edges` (indexed by brain_ref × from/to/relation), and
`goat.brain_timeline_entries`. Retrieval just never looks at them.

## Principles

1. **The database is the index.** Anything derivable from a document is computed once at write
   time (the projection in `packages/db/src/goat-brain-files.ts` already works this way) and
   queried via indexed SQL. Nothing is re-derived per query.
2. **LLM calls only where they pay.** The agent consumer already does query reformulation (it
   retries with better phrasings) and reranking (it reads snippets and picks what to `get`).
   Query expansion and chat-model reranking are deleted, not moved.
3. **One retrieval implementation.** A single in-process read module serves chat, MCP, the
   ingestion agent's reads, and any future HTTP surface. The CLI keeps its filesystem retrieval
   only for genuinely local roots (dev, offline); it stops being the transport for DB-backed
   reads.
4. **Reads never touch the write machinery.** No materialize, no sync-back, no conflict
   detection, no process spawn.

## The read module

`packages/db/src/goat-brain-read.ts` (needs DB; imports fusion/blend helpers from
`@opencompany/goat-brain`). Callers do authz first (`requireGoatBrainAccess`), then:

```ts
type GoatBrainReadContext = {
  brainRef: string;
  gatewayApiKey?: string;   // absent → lexical-only ranking
  db?: DbClient;            // neon-http (web) or pooled (runner)
};

function searchGoatBrain(ctx, opts: {
  text: string;
  folder?: string;          // prefix match, as today
  type?: string;            // entity type filter (person, company, ...) — new
  kind?: "page" | "evidence";
  since?: string;
  limit?: number;           // default 10
  hops?: number;            // default 0; explicit graph expansion
  includeMerged?: boolean;
  includeArchived?: boolean;
  lexicalOnly?: boolean;    // reproducibility switch, as today
}): Promise<GoatBrainSearchHit[]>;

// Point reads. Batch-first: after a search an agent typically wants 2–5 pages.
function getGoatBrainDocuments(ctx, ids: string[]): Promise<GoatBrainDocumentRead[]>;
function getGoatBrainTimeline(ctx, id: string, opts?: { since?: string; limit?: number }):
  Promise<GoatBrainTimelineEntry[]>;
function listGoatBrainDocuments(ctx, opts?: { folder?: string; type?: string; limit?: number }):
  Promise<GoatBrainDocumentSummary[]>;
```

### Hit shape (built for the agent's next move)

```ts
type GoatBrainSearchHit = {
  id: string; title: string; type: string; kind: string;
  folder: string; status: string; updatedAt: string;
  score: number;
  signals: Array<"lexical" | "name" | "vector" | "graph">;
  snippet: string;               // compiled truth, capped ~1200 chars
  neighbors: Array<{
    id: string; title: string; kind: string; type: string; folder: string; status: string;
    relationType: string; sourceKind: string; direction: "out" | "in";
  }>;
  via?: GoatBrainGraphHop[];     // only for hop-expanded hits
};
```

`neighbors` (top ~5 edges per hit, titles joined in) is the key addition: it gives the agent one
hop of *metadata* on every hit so it can decide what to `get` next, which covers most of what
score-polluting graph expansion was doing.

## Index plane (precomputed at write time)

Migration `0103` (hand-authored SQL + journal entry, per the 0100 precedent):

```sql
CREATE EXTENSION IF NOT EXISTS vector;   -- pg_trgm already enabled (0042)

ALTER TABLE goat.brain_documents
  ADD COLUMN search_text text NOT NULL DEFAULT '',
  ADD COLUMN name_text  text NOT NULL DEFAULT '',
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS
    (to_tsvector('english', coalesce(search_text, '') || ' ' ||
                 coalesce(asset_extracted_text, ''))) STORED;  -- asset text (0102) folded in
CREATE INDEX ... ON goat.brain_documents USING gin (search_tsv);
CREATE INDEX ... ON goat.brain_documents USING gin (name_text gin_trgm_ops);

CREATE TABLE goat.brain_document_embeddings (
  document_id  text PRIMARY KEY REFERENCES goat.brain_documents(id) ON DELETE CASCADE,
  brain_ref    text NOT NULL REFERENCES goat.brains(id) ON DELETE CASCADE,
  content_hash text NOT NULL,       -- hash of the embedded text; staleness check
  model        text NOT NULL,       -- mismatch ⇒ treated as missing (model migration for free)
  embedding    vector(1536) NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ... ON goat.brain_document_embeddings (brain_ref);
```

- `search_text` = title + aliases + compiled truth + timeline summaries + relation text, composed
  in `documentValues()` (`goat-brain-files.ts`) — the projection already computes every part.
  The migration backfills it from existing columns. `name_text` = title + aliases, for trigram
  entity lookup. `asset_extracted_text` (binary assets, 0102) joins the tsvector directly rather
  than via `search_text` because extraction updates bypass `documentValues()`.
- One weight class, one tsvector. Title emphasis comes from the name-boost stage (below), not
  from `setweight` gymnastics over jsonb columns.
- **One embedding per document**, over title + aliases + compiled truth (capped ~8k chars). No
  chunking: compiled truth is curated and short by design; if a page is too long to embed whole,
  that's a curation bug, not a retrieval feature gap. No ANN index initially — per-brain corpora
  are ≤ low thousands of rows, and the `brain_ref` btree filter runs first; add HNSW only if a
  brain crosses ~50k docs.
- Validity is enforced at write (`deriveGoatBrainFileProjection` throws), so the read plane drops
  `includeInvalid` and per-query re-validation entirely.

### Embedding lifecycle: query-time write-through

Same cache semantics as today, but durable. At query time (semantic mode only): join documents ↔
embeddings; rows whose `content_hash`/`model` don't match current are "missing"; embed missing
docs in one batched gateway call (cap ~64/query; log and degrade to lexical for the remainder)
and upsert. Steady state after the first query is warm forever — a rewrite re-embeds exactly the
changed page. One mechanism, self-healing, no write-path coupling; opportunistic write-time
warming can be added later behind the same table without API change.

## Query pipeline

```
parse filters ─► [ FTS candidates ]  [ trigram name candidates ]  [ vector candidates ]   (parallel)
                        └──────────────────┬──────────────────────────┘
                                     RRF fusion (k=60)
                                     name boost (exact/substring on title+aliases)
                                     optional hop expansion over brain_edges (decay 0.5)
                                     freshness blend (0.85 relevance / 0.15, 90d half-life)
                                     top-limit ─► join neighbors ─► hits
```

1. **Lexical** — one SQL: `ts_rank_cd(search_tsv, websearch_to_tsquery('english', $q))` with all
   filters as WHERE clauses (folder prefix, type, kind, since, status), `LIMIT 50`.
2. **Name** — one SQL: `similarity(name_text, $q)` where `name_text % $q`, `LIMIT 20`.
   Typo-tolerant entity lookup ("acme corp" → *Acme Corporation*), the single most common agent
   query shape. Same pattern as `recall.ts`.
3. **Vector** — only when a gateway key is present and not `lexicalOnly`: embed the query (one
   short gateway call), backfill missing doc embeddings (see above), then
   `embedding <=> $vec LIMIT 50` filtered by `brain_ref` + the same filters via join.
4. **Fusion & blend** — reciprocal-rank fusion of the ranked lists, then the existing name boost
   and recency blend, unchanged (`fuse.ts`, `blend.ts` logic moves in; the constants carry over).
5. **Hops (opt-in, default 0)** — one SQL pulls the brain's edges for the seed set from
   `goat.brain_edges` (both directions; `graphDirection` is dropped — no consumer needed it),
   walk in-memory with decay 0.5 from the top-20 seeds exactly as today, `via` paths preserved.
6. **Neighbors** — one SQL fetches edges + titles for the final hit ids.

Per search: 3–4 DB roundtrips + at most 2 gateway calls (query embed, occasional backfill batch).
No LLM chat calls anywhere in the pipeline.

**Deleted, deliberately:**
- *Query expansion* (chat call → 3 rewrites). The agent is the query expander; it sees results
  and reformulates with actual context, which beats blind paraphrase.
- *LLM rerank* (chat call → JSON id array over top 20). The agent reranks by reading snippets.
  The provider seam stays (`RetrievalProviders`-shaped), so if evals later show a precision gap
  we slot in a dedicated reranker model — not a chat model parsing JSON.
- *`graphDirection`*, *`includeInvalid`* options.

## Point reads

`getGoatBrainDocuments(ctx, ids)` — one SQL over `brain_ref + brainId IN (...)`, with:

- **Alias + merge resolution.** An id that doesn't match `brainId` resolves via `aliases`
  containment, then via `mergedInto` (returns the merge target with `resolvedFrom` noted). Agents
  address pages by the names they saw in prose; today's CLI `get` only matches exact ids.
- **Parsed sections, not raw markdown**: frontmatter, compiled truth, timeline (capped at the
  most recent ~20 entries; full history via `getGoatBrainTimeline`, which reads the already-derived
  `goat.brain_timeline_entries` with `since`/`limit` in SQL), and a `links` block — all edges in
  both directions with titles. `get` becomes the graph-navigation primitive.

A point read is one indexed SQL roundtrip (~30–80ms) instead of full-brain materialize + spawn.

## Consumer migration

| Consumer | Today | Target |
| --- | --- | --- |
| Chat `goat_brain` reads (`query`, `get`, `timeline`, `list`, `folder`) | materialize + CLI spawn | read module in-process; tool run tracing stays at the transport layer (`goatBrainToolRuns`) |
| Chat `goat_brain` mutations | materialize + CLI + sync-back | unchanged (write mediation is a separate track) |
| MCP `query_brain` (`app/api/mcp/[brainId]`) | CLI spawn per call | read module directly; add a `get_document` tool |
| Ingestion agent reads (runner tool loop) | CLI against per-job root | **stays on the CLI, deliberately**: the loop writes to its materialized root mid-job and syncs to the DB only at job end, so DB reads would miss the agent's own uncommitted writes (create page → get page would 404). It still gains from the expansion/rerank deletion; priming its embedding cache from `brain_document_embeddings` at materialize time is a possible follow-up |
| CLI on a local filesystem root (dev/offline) | `queryGoatBrain(root, ...)` | unchanged — `corpus.ts`/`bm25.ts` and the file embedding cache stay for this mode only, minus expansion/rerank (delete from `providers.ts` too) |
| `doctor` | CLI | unchanged (integrity checks legitimately want the full corpus) |

## Budget (typical brain, warm embeddings)

| Operation | Today | v2 |
| --- | --- | --- |
| `query` (semantic) | ~3–9s, O(corpus) embed tokens + 2 chat calls | ~300–600ms, 1 query-embed call |
| `query` (lexical) | ~1–2.5s | ~150–300ms |
| `get` one page | ~0.5–1.5s | ~30–80ms |
| Embedding spend | re-embed corpus per web query | once per content change, ever |

A fixed, deterministic pipeline also makes retrieval evaluable: a small golden-query set per test
brain (query → expected ids in top-k) becomes a cheap regression test, which was meaningless when
two chat-model calls sat mid-pipeline.

## Unchanged from v1 of this doc

- **Plane 2 (librarian):** read-only agent loop for synthesis questions, same harness as the
  ingestion agent, citations machine-checked against the brain. It now sits on the read module
  like every other consumer. Deferred until plane 1 lands.
- **Addressing & authz:** `brain_ref` is the only address; human sessions via
  `requireGoatBrainAccess`, runner jobs pinned at enqueue, external agents via per-brain MCP
  OAuth. External consumers get reads only; writes enter through ingestion jobs.
- **No cross-brain calls.**

## Implementation slices (each its own issue)

1. Migration 0103 (extension, columns, indexes, embeddings table, `search_text` backfill) +
   projection writes `search_text`/`name_text`.
2. Read module: search pipeline (FTS + trgm + vector + fusion/blend/hops/neighbors) + point
   reads; port `retrieval.test.ts` invariants against a test DB.
3. Migrate chat read commands + MCP tools onto it; delete expansion/rerank from `providers.ts`.
4. Golden-query retrieval eval.

## Non-goals

Write-path changes, nightly curation, cross-brain routing, chunked/section embeddings, ANN
indexes, source-resolver hydration, and the librarian itself.
