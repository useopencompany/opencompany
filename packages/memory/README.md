# @opencompany/memory

Structured, evidence-first memory for the personal agent. A small CLI over a tree of Markdown
files under `agent/memory/`, designed so an agent can capture durable facts, back them with
cited evidence, and retrieve them later. It is the only safe way to read or write structured
memory — the runner exposes it as the `memory` tool and forbids direct edits under
`agent/memory/`.

## Model

Two kinds of document, each a Markdown file whose name is its globally-unique id:

- **Canonical objects** — derived, updateable views of one real-world thing:
  `person`, `company`, `project`, `customer`, `decision`, `concept`, `theme`.
- **Evidence** — immutable source records that canonical truth is compiled from:
  `meeting`, `conversation`, `doc`, `research`, `correction`. Every evidence record carries
  provenance (`source.ref`, `captured_at`) and one or more `subjects` (canonical ids it backs).

Each file has a two-layer body: a hand-curated **`## Compiled truth`** on top and an
append-only **`## Timeline`** below the sentinel. Compiled truth cites evidence with
`[^ev:<evidence-id>]` footnotes.

## Status lifecycle

```
draft ──(rewrite with valid citations)──▶ active ──▶ deprecated
                                            │
                                            └──(merge)──▶ merged (redirect stub)
```

- **draft** — uncited scratch truth. New objects start here.
- **active** — compiled truth is backed by evidence citations. An object reaches `active` when
  `rewrite` succeeds with valid, linked citations (it auto-promotes from `draft`).
- **deprecated** — superseded but kept for history; down-ranked in retrieval.
- **merged** — resolved into another record via `merge`; left as a redirect stub.

**Citation contract.** Uncited compiled truth may only exist in a `draft`. `rewrite` requires
every `[^ev:<id>]` to resolve to a valid evidence record that lists the subject. `create
--status active` with compiled truth is held to the same gate, so "truth" can never start life
as established, uncited fact — the normal path is `create` (draft) → `append-evidence` →
`rewrite`.

## Retrieval (`query`)

Hybrid pipeline: BM25 lexical (always, offline) fused with optional model-backed query
expansion, vector search, and rerank (engaged only when an AI Gateway key is present and
`--lexical-only` is not set), then a freshness/position blend.

- **Consistency with `doctor`.** `query` hides `merged` redirect stubs and records that fail
  strict validation by default, so it never returns what `doctor` would reject. Opt back in with
  `--include-merged` / `--include-invalid` for recovery or debugging.
- **`--hops N`.** Follows `related` links and evidence citations/subjects `N` steps out from the
  top text hits, pulling linked neighbors into the results with a per-hop decaying boost — so a
  relationship question ("the decision tied to this company") surfaces the connected object even
  when it didn't match the text. Default `0` keeps retrieval flat.
- **Name boost.** A query that is a record's title or alias foregrounds that record, so naming an
  entity reliably returns it rather than an incidental mention.
- **Status weighting.** `draft` and `deprecated` records are down-ranked relative to `active`.

## Behaviors worth knowing

- **Merge keeps the old name.** `merge --from a --into b` keeps `a` as an alias on `b`, so the
  old id still resolves to the survivor, and re-points evidence subjects from `a` to `b`.
  Compiled truth is not auto-merged — re-synthesize it with `rewrite` so citations stay valid.
- **`get --section`.** `truth | timeline | frontmatter | all` scopes both the human text and the
  `--json` payload to that part (every section still returns `id`/`path`).
- **Concurrency.** Each file write is atomic, but read-modify-write has no locking: concurrent
  writes to the same object are last-write-wins. Don't run two writes against one object in
  parallel.

## Commands

`create`, `get`, `query`, `append-evidence`, `rewrite`, `alias`, `merge`, `delete`, `doctor`.
Run `memory help` for the full option list, or add `--json` to any command for machine-readable
output.
