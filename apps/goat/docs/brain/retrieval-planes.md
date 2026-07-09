# Goat Brain Retrieval Planes (design)

Step 4 of issue #597. This is a design doc, not an implementation plan with dates —
implementation gets its own issues. It defines how anything that is not a brain writer reads the
brain: a fast **deterministic read plane** and an **agentic synthesis plane** (the librarian) on
top, and how external consumers address a brain at all.

Design principle recap (from #597): the brain is operated by agents — writes and curation are
always agent-mediated — but reads get two tiers. Everything here operates strictly within a
single brain (`brain_ref`); cross-brain routing is out of scope.

## What exists today

The retrieval machinery is already good; the *surface* is the problem.

- `queryGoatBrain` (`packages/goat-brain/src/retrieval/`) is a hybrid ranker: BM25 lexical
  search, optional query expansion + embeddings + rerank through the Vercel AI Gateway
  (`gateway.ts`), reciprocal-rank fusion, graph expansion along relations/wiki-links (`hops`,
  `graphDirection`, decay 0.5), title/alias name boost, and a recency blend. Filters: `folder`,
  `since`, `includeInvalid`, `includeMerged`.
- But every consumer reaches it the same expensive way: materialize the **entire brain** from
  `goat.brain_documents` into a temp dir (`materializeGoatBrainFilesToRoot`), spawn the bundled
  CLI against that root, then throw the root away. Chat does this per `goat_brain` tool call
  (`apps/goat/lib/brain-cli.ts`), the ingestion agent does it per job
  (`apps/runner/src/goat-brain-agent-ingest.ts`).
- The embedding cache lives at `.brain/embedding-cache.json` **inside the root**, so it is
  discarded with the temp dir: every model-assisted query re-embeds the corpus from scratch.
- The chat `goat_brain` tool exposes the full CLI, including mutations. That predates principle
  3 (external agents never mutate the brain directly); the read planes below are how chat and
  every other consumer eventually stop needing raw CLI access for reads, and mutations narrow to
  brain agents.

## Plane 1 — deterministic read plane

A fast search/read API any agent can call, with **no LLM generation in the loop**. Two layers:
an in-process module (the only place retrieval logic lives) and thin transport wrappers.

### Core module

New `packages/db/src/goat-brain-read.ts` (needs DB access, so it sits next to
`goat-brain-files.ts`, importing ranking from `@opencompany/goat-brain`):

```ts
type GoatBrainReadContext = {
  brainRef: string;           // already access-checked by the caller's authz layer
  gatewayApiKey?: string;     // absent → strictly lexical ranking
};

// Search: queryGoatBrain semantics, minus filesystem.
function searchGoatBrain(ctx: GoatBrainReadContext, options: GoatBrainQueryOptions):
  Promise<GoatBrainQueryHit[]>;

// Point reads. Parsed document, not raw markdown, so callers never re-implement parsing.
function getGoatBrainDocument(ctx, id: string):
  Promise<{ doc: GoatBrainDocument; folder: string; kind: GoatBrainKind } | null>;
function getGoatBrainTimeline(ctx, id: string, opts?: { since?: string; limit?: number }):
  Promise<GoatBrainTimelineEntry[]>;
function listGoatBrainDocuments(ctx, opts?: { folder?: string; type?: string; limit?: number }):
  Promise<GoatBrainDocumentSummary[]>;
```

Properties:

- **Read-only by construction.** No sync-back, no conflict detection, no mutation queue. The
  corpus is built directly from `goat.brain_documents` rows for the `brain_ref` (adapting
  `buildCorpus` to take records instead of a filesystem root); no temp dir, no CLI spawn, no
  bundle. This is the latency win that makes the plane callable from a chat turn.
- **Determinism is a mode, not a promise.** `lexicalOnly` (no gateway key, or explicitly set) is
  fully deterministic. With a key, expansion/embeddings/rerank are allowed — they are ranking
  assists, never generation, and failures already degrade silently to lexical. Callers that need
  reproducibility pass `lexicalOnly: true`.
- **Durable embedding cache.** Move the cache from `.brain/embedding-cache.json` to a table
  (`goat.brain_embeddings`: `brain_ref`, `content_hash`, `model`, `vector`), keyed exactly like
  today's in-root cache (`corpus.ts` already keys by namespace + content hash). Write-through on
  query. The CLI keeps its file cache for local roots; the read plane never touches it.
- **Snippet discipline.** Hits return compiled-truth snippets capped as today (~1200 chars) with
  the existing "run `goat-brain get <id>`" truncation marker replaced by a plane-appropriate one
  ("fetch the document"). Full documents only via `getGoatBrainDocument`.

### Transports

Thin wrappers that do authz, then call the module:

1. **In-process (Goat web + runner):** call the module directly after
   `requireGoatBrainAccess(userWorkosId, brainRef)` (`packages/db/src/goat-workspaces.ts`).
   Chat's `goat_brain` read commands and the runner's read paths migrate here over time.
2. **HTTP (`apps/goat/app/api/brains/[brainRef]/...`):** `POST search`, `GET documents/:id`,
   `GET documents/:id/timeline`. Session-cookie authed for the Goat UI; token-authed for
   machines (below). This is the surface other OpenCompany products call.
3. **MCP:** the per-brain MCP connector (separate branch; OAuth via AuthKit) exposes
   `query_brain` / `get_document` tools that are these same module calls. The MCP server is a
   transport, not a second implementation.

## Plane 2 — the librarian (agentic synthesis)

For questions a ranked hit list can't answer: "what's the state of our Acme relationship and
who owns it?" requires walking links, merging timelines across pages, and composing an answer.

- **Same harness as the ingestion agent.** Reuse the `runIngestAgentLoop` pattern from
  `apps/runner/src/goat-brain-agent-ingest.ts` — an AI SDK tool loop over a single `goat_brain`
  tool — but with the tool allow-list cut to the read-only set (`query`, `get`, `timeline`,
  `list`, `folder`, `help`) and, once plane 1 lands, backed by the read module instead of a
  materialized CLI root. Step ceiling ~16 (reads, not writes), timeout well under the ingestion
  agent's 10 minutes.
- **Opinionated system prompt:** brain-first (answer only from what `query`/`get` return; say
  "the brain doesn't know" rather than guess); walk `via` graph paths and merge timelines
  chronologically when the question spans entities; keep the pointer discipline — every claim in
  the answer carries a typed inline citation (`[[page:...]]`, `[[evidence:...]]`,
  `[[source:provider:id]]`, per `GOAT_BRAIN_POINTER_COPY_RULE`); flag stale compiled truth
  (old `updatedAt`) instead of presenting it as current.
- **Output contract:** markdown answer + structured metadata `{ pagesRead: string[],
  citations: InlineLink[], confidence: "grounded" | "partial" | "not_in_brain" }`. Citations are
  machine-checkable against the brain — an eval harness can verify every cited id exists, which
  is the regression test for librarian quality. When source resolvers land
  (`packages/goat-brain/src/source-resolvers.ts`), `[[source:...]]` citations hydrate to live
  links at render time.
- **Two invocation modes:**
  - *Bounded sync* — an `ask_brain` tool for Goat chat and the MCP connector. The chat agent
    delegates synthesis questions instead of running many raw `goat_brain` calls itself.
  - *Durable* — a `brain_agent_answer` job kind on the existing `brain_ingest_jobs` queue
    (leases, heartbeat, backoff for free) for deep synthesis invoked from background tasks.
- The librarian never mutates. If it discovers gaps worth fixing (broken links, missing pages),
  it reports them in metadata; curation is the nightly cycle's job, not the librarian's.

## Addressing the brain (per-brain surface)

How external agents — Goat chat, OpenCompany workspace agents, cron jobs, other products — name
and reach a brain, per principle 7:

- **`brain_ref` is the only address.** Every read-plane call, librarian invocation, and
  ingestion job carries exactly one. Nothing accepts a user id and "figures out" a brain
  server-side except at the edge: v1 routing (webhooks, chat default) resolves
  `getDefaultGoatBrainForUser` **at enqueue/callsite**, and everything downstream is pinned —
  the same shape step 2 already established for ingestion jobs.
- **Three authz paths, one check.** (a) Human sessions: WorkOS session →
  `requireGoatBrainAccess`. (b) First-party machines (runner jobs): the job row's `brain_ref`
  was access-checked at enqueue; the runner trusts it. (c) External agents: per-brain OAuth
  tokens from the MCP connector (AuthKit), where the token's grant *is* the brain — a token for
  brain A cannot form a request about brain B. All three converge on the same access predicate
  over `goat.brains` / workspace membership.
- **Capability tiers per consumer:** external consumers get read plane + librarian only. Write
  access is not part of this surface at all — external content enters through ingestion jobs
  (which run the brain's own agent), never through a document-write API. This is what "the brain
  is operated by agents" means at the boundary.
- **No cross-brain calls.** An agent holding access to two brains makes two scoped calls and
  does its own joining. The brain never joins across `brain_ref`s on a caller's behalf.

## Implementation slices (each its own issue)

1. Read module + corpus-from-rows + durable embedding cache table; migrate chat `goat_brain`
   read commands onto it (mutations keep the CLI path until brain-agent mediation lands).
2. HTTP read surface under `apps/goat/app/api/brains/[brainRef]/`; wire the MCP connector's
   tools to it.
3. Librarian v1: read-only tool loop in the runner + `ask_brain` in chat; citation-validity
   eval.
4. `brain_agent_answer` durable job kind.

## Non-goals here

Nightly curation, cross-brain routing, source-resolver implementation, embedding model
migration, and any change to how brain *writes* happen (that contract is steps 2–3).
