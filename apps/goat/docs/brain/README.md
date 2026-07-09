# Goat Brain

The brain is Goat's per-user (and per-workspace) knowledge store: Markdown documents with typed
frontmatter, an append-only evidence timeline, and a lightweight graph of wiki-links and typed
relations. Documents live in `goat.brain_documents` rows — Markdown is the source of truth, the
database is the storage. Writes are agent-mediated; reads are moving toward a fast deterministic
read plane.

This section is the fast-orientation reference for anyone (human or agent) working on the brain.
The pages below are contracts and maps, not design narratives — for the original design rationale
see `apps/goat/research/goat-brain-v1.md` and issue #597.

## Pages

| Page | What it answers |
| --- | --- |
| [data-model.md](./data-model.md) | **Reference for all enums and grammars**: kinds, the 8 entity types, statuses, default folders, id/folder/source-ref patterns, document anatomy, DB tables. `packages/goat-brain/src/schema.ts` remains the code-level source of truth. |
| [ingestion.md](./ingestion.md) | How content enters the brain: source items, the ingest job queue, and the three pipelines (Jamie meetings, chat captures, legacy template writes). |
| [tools-and-cli.md](./tools-and-cli.md) | Every surface that touches a brain: the `goat-brain` CLI commands, chat tools (`goat_brain`, `save_to_brain`), and the per-brain MCP connector. |
| [pointer-copy-contract.md](./pointer-copy-contract.md) | How brain writers cite external sources: pointer vs. snapshot rules per source class, source-ref grammar, enforcement. |
| [retrieval-planes.md](./retrieval-planes.md) | Design for how non-writers read the brain: deterministic read plane + librarian agent (step 4 of #597, partially implemented). |

## Mental model in five lines

1. A **brain** (`goat.brains` row, addressed by `brain_ref`) holds **documents** addressed by
   `brain_id` slugs. Never confuse the two: `brain_ref` picks the brain, `brain_id` picks the doc.
2. Every document is either a **page** (kind `page`, editable knowledge) or an **evidence record**
   (kind `evidence`, immutable sourced snapshot). Kind is determined by folder: anything under
   `evidence/` is evidence, everything else is a page.
3. **Types are tags, folders are navigation.** A document has exactly one of 8 entity types
   (`person`, `company`, …) and lives in exactly one free-form folder path.
4. Each document is frontmatter + `## Compiled truth` (current state) + `## Timeline`
   (append-only dated evidence entries).
5. Claims carry provenance: inline links (`[[page:...]]`, `[[evidence:ev-...]]`,
   `[[source:provider:id]]`) and `provider:id` source refs, per the
   [pointer/copy contract](./pointer-copy-contract.md).

## Code map

| Area | Where |
| --- | --- |
| Schema constants, patterns, validators | `packages/goat-brain/src/schema.ts` — the code-level source of truth every enum in [data-model.md](./data-model.md) mirrors |
| Zod schemas | `packages/goat-brain/src/schemas.ts` |
| Document parse/serialize (truth + timeline sections) | `packages/goat-brain/src/document.ts`, `entry.ts`, `frontmatter.ts` |
| Inline links and graph edges | `packages/goat-brain/src/inline-links.ts`, `edges.ts`, `wiki-links.ts` |
| Hybrid retrieval (BM25 + embeddings + graph expansion) | `packages/goat-brain/src/retrieval/` |
| Validation and `doctor` findings | `packages/goat-brain/src/validate.ts`, `health.ts` |
| Pointer/copy prompt constant | `packages/goat-brain/src/pointer-copy.ts` (`GOAT_BRAIN_POINTER_COPY_RULE`) |
| CLI | `packages/goat-brain/src/cli/index.ts` |
| DB tables (Drizzle) | `packages/db/src/goat-schema.ts` (`goatBrain*` exports) |
| DB ↔ file materialization | `packages/db/src/goat-brain-files.ts` |
| Chat tools | `apps/goat/lib/brain-cli.ts` (`goat_brain`), `apps/goat/lib/brain-capture.ts` (`save_to_brain`) |
| Ingestion worker + handlers | `apps/runner/src/goat-brain-ingest-worker.ts`, `goat-brain-agent-ingest.ts`, `goat-brain-jamie-writes.ts` |
| Source item normalization | `packages/goat-brain/src/source-items.ts` |
| Per-brain MCP connector | `apps/goat/app/api/mcp/[brainRef]/[transport]/route.ts` |

## Invariants worth memorizing

- **Writes are agent-mediated.** External consumers never get a document-write API; content enters
  through ingestion jobs or chat capture, both of which run a brain agent. Main chat reads through
  `goat_brain`, captures new content through `save_to_brain`, and cannot create canonical Brain
  entities directly.
- **Everything is scoped to one `brain_ref`.** No query, job, or tool call joins across brains.
- **Evidence is immutable and zoned.** Evidence records live under `evidence/`, get `ev-*` ids,
  and pages link to them rather than inlining content.
- **A page cannot become `active` without citing evidence** — `goat-brain set --status active`
  requires the compiled truth to contain at least one `[[evidence:...]]` link.
