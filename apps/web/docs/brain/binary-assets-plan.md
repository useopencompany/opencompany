# Binary assets in the Goat Brain (PDF v1)

> **Status: implemented** (single PR, migration `0102_goat_brain_binary_assets`).
> The shipped contract lives in [data-model.md — Binary assets](./data-model.md#binary-assets-pdf);
> this document is the original design plan. Two deviations from the plan as written:
> the extraction stage runs inside the upload agent-ingest handler (no separate job kind),
> and re-upload ("Replace file") shipped in v1.

Plan for first-class binary documents in the brain: a user drops a PDF into a
folder, clicking it renders the PDF, and the brain still treats it as a full
graph citizen (type, status, relations, backlinks, timeline, search).

## Design invariants

1. **One row, one folder entry, one artifact.** A PDF is a single
   `goat.brain_documents` row with `format: "pdf"` — not a stub page plus an
   attachment. No sibling documents.
2. **The DB row is the metadata home for binaries.** Frontmatter stays
   canonical for markdown documents; for binaries the metadata columns
   (`entityType`, `status`, `relations`, `sources`, `aliases`, timeline) are
   authoritative directly. Nothing about the v1 metadata contract changes.
3. **Bytes live in blob storage.** `assetStorageKey` points at the private
   blob store. Blob keys are immutable; replacing a file mints a new key.
4. **The user sees the file; the agent sees markdown.** The viewer branches on
   `format` and renders the PDF inline with metadata as side-panel chrome. The
   CLI/file plane materializes a *generated, non-authoritative* markdown
   projection of the row so query/get/rewrite/link/timeline-add keep working
   unchanged. The projection is regenerated from the row on every
   materialization — there is no sidecar that can drift.
5. **`content` stays canonical markdown for every row.** For binaries,
   `content` holds the synthesized projection (frontmatter + compiled truth +
   timeline). Versioning, hashing, and sync reuse the existing machinery.
   Extracted text is a separate column, not part of `content`.

## Step 0 — Harden existing paths against non-markdown rows

Today a `format: "pdf"` row would corrupt materialization and fail sync.
Before any upload UI ships:

- `packages/db/src/goat-brain-files.ts`
  - `materializeGoatBrainFilesToRoot` (~L468): branch on `row.format`;
    non-markdown rows write the projection described in Step 4, never the
    legacy-entry path.
  - `documentValues` (~L768): stop hardcoding `mimeType`/`originalFileName`/
    `assetStorageKey` to markdown defaults — preserve the row's asset fields
    across sync upserts.
  - `deriveGoatBrainFileProjection` / `syncGoatBrainFiles`: format-aware
    validation so a projection file syncs back onto the existing pdf row
    (updating metadata + compiled truth + timeline) without clobbering asset
    columns or `format`.
- `apps/web/lib/brain.ts` (~L337): stop nulling `originalFileName`/
  `assetStorageKey` in the view constructor.

Ship this as its own PR — it is pure hardening and unblocks everything else.

## Step 1 — Storage contract + migration

- New columns on `goat.brain_documents` (hand-author SQL + journal entry;
  `db:generate` is unusable):
  - `asset_extracted_text` (text, nullable, capped ~200KB at write time) —
    machine-extracted text for search and agent context. Never user-edited.
  - `asset_content_hash` (text, nullable) — sha256 of the blob bytes (dedup +
    re-upload detection).
  - `asset_size_bytes` (integer, nullable).
- Widen `brain_source_items` check constraints: `sourceProvider` gains
  `"upload"`, `sourceType` gains `"asset"` (Step 3 uses these).
- No new frontmatter fields. The projection's frontmatter is the existing
  contract; the asset linkage is expressed in `sources` as
  `upload:<document-id>` under the existing `provider:id` grammar, and the
  blob key stays DB-only (it is an implementation detail, not brain content).

## Step 2 — Upload path (UI → blob → row → job)

- **Upload route** `POST /v1/brains/{brainId}/assets` on the canonical API:
  authorize Brain write access, accept multipart bytes, compute the authoritative
  sha256, copy into the private Blob store, and persist through one idempotent command.
  The former `/api/brain-assets/upload` token route remains only for cached clients
  and rollback until the #1203 compatibility observation window closes.
- **Within the canonical upload command**:
  - slug the filename → `brainId` (existing id pattern, collision-suffix);
  - `folderPath` = the folder the user dropped into; `kind` derived from the
    folder per the existing zone rule (evidence/ → evidence);
  - defaults: `type: "source"`, `status: "draft"`, `title` from filename;
  - `content` = skeleton projection (frontmatter + `## Compiled truth` with a
    one-line "Uploaded PDF, ingestion pending");
  - asset columns set; version row written via the normal upsert path;
  - create a `brain_source_items` row (`provider "upload"`, `type "asset"`,
    `sourceRef upload:<docId>`, rawPayload = upload metadata) and enqueue via
    `upsertGoatBrainSourceItemAndEnqueue`.
- **UI entry points** in `GoatBrainView`: drag-and-drop onto the folder pane +
  an "Upload file" affordance in the new-document menu. Reuse the existing
  ingest indicators for the pending state.
- **Serving route** `GET /v1/brain-assets/{docId}`: resolve doc → check brain
  access → private blob `get` → stream with stored `mimeType` and
  `Content-Disposition: inline`.

## Step 3 — Ingestion: extract, then curate

Two stages on the existing job rail, mirroring the Jamie pattern
(deterministic normalize → agent curate):

1. **`brain_source_item_ingest` handler for provider "upload"**
   (deterministic, in `apps/runner`): fetch blob, extract text (pure-JS PDF
   text extraction, e.g. `unpdf`), write `asset_extracted_text` (capped),
   `asset_content_hash`, `asset_size_bytes`. On failure: mark source item
   failed; doc stays draft with the failure indicator.
2. **`brain_agent_ingest` handler for provider "upload"**: existing agentic
   CLI loop. Prompt = extracted text (byte-bounded, same as transcripts) +
   the standard system prompt. The agent rewrites the compiled truth
   (summary), fixes `type`/`title`, creates `[[page:...]]` backlinks and
   relations, adds a timeline entry citing `upload:<docId>`, and promotes
   draft → active under the normal citation discipline.

New handler descriptors register in
`apps/runner/src/goat-brain-ingest-worker.ts` next to the Jamie/goat-chat
ones; no new job kinds needed.

## Step 4 — File-plane projection + CLI

- **Materialization** (`materializeGoatBrainFilesToRoot`): a pdf row writes
  `<folder>/<id>.md` containing frontmatter + `# Title` + `## Compiled truth`
  + timeline (i.e. exactly `row.content`), plus a read-only
  `## Extracted text` section appended from `asset_extracted_text` with a
  sentinel comment marking it generated. The binary itself is not
  materialized into the sandbox — the agent has no use for bytes.
- **Sync-back**: `deriveGoatBrainFileProjection` strips the extracted-text
  section before hashing/persisting, so agent edits flow into compiled
  truth/frontmatter/timeline exactly like markdown docs, and edits inside the
  generated section are discarded. Asset columns pass through untouched.
- **CLI**: `list`/`get`/`query` surface `format`. No CLI upload in v1
  (UI-only). `rewrite`, `set`, `alias`, `link`, `timeline-add`, `move`,
  `merge` all work via the projection. `delete` works (Step 6 handles the
  blob).
- **Retrieval**: `retrieval/corpus.ts` gains an `extractedText` field sourced
  from the generated section; `bm25.ts` adds it to the field list with a low
  weight (below `compiledTruth`), so PDFs are findable by their content
  without drowning curated pages.

## Step 5 — Viewer branch (the UX core)

In `apps/web/components/GoatBrainView.tsx`:

- `format === "markdown"` → existing `MarkdownGoatBrainEditor`, unchanged.
- `format === "pdf"` → new `PdfDocumentView`:
  - inline `<iframe>`/`<embed>` of `/v1/brain-assets/<docId>` (native
    browser PDF rendering; no pdf.js dependency in v1), full-height;
  - metadata side panel (or collapsible header strip): type, status, folder,
    aliases, relations chips (existing chip renderer), backlinks, the agent's
    compiled-truth summary, timeline, original filename + size + download;
  - existing rename/move/delete/status actions preserved.
- Tree/list: single entry per PDF with a file-type icon; wiki-link chips
  (`[[page:...]]`) resolve to the PDF doc and open this view.

Clicking the file shows the file. The brain metadata wraps around it instead
of standing in front of it.

## Step 6 — Lifecycle

- **Delete**: `deleteGoatBrainFile` writes the version row (metadata +
  projection content; bytes are not versioned), deletes the doc row, then
  best-effort `del()` of the blob. Accepted v1 limitation: restoring a
  deleted PDF restores its brain page, not its bytes.
- **Replace / new version**: re-upload onto an existing doc mints a new blob
  key, snapshots a version, updates asset columns, re-enqueues extraction.
  The agent pass runs again and reconciles the compiled truth.
- **Move/rename**: row-only; blob key untouched.

## Step 7 — Query plane + docs

- MCP `query_brain` and CLI `query` return pdf hits with the compiled-truth
  excerpt; the web UI resolves them to the PDF view.
- Update `data-model.md` (format section becomes real) and
  `pointer-copy-contract.md` (assets: bytes-by-key, copy rule for extracted
  text).

## Sequencing

| PR | Contents | Risk |
|----|----------|------|
| 1 | Step 0 hardening + Step 1 migration | Low; pure prep, no UX change |
| 2 | Step 2 upload + serve routes + Step 5 viewer (renders "ingestion pending") | Medium; new routes, blob wiring |
| 3 | Step 3 ingestion handlers + Step 4 projection/CLI/retrieval | Medium; runner + sync surface |
| 4 | Step 6 lifecycle + Step 7 docs/MCP polish | Low |

PR 1 must land (and migrate) before PR 2 is enabled anywhere, since the first
pdf row written against unhardened sync would corrupt materialization.

## Explicit non-goals (v1)

- docx and images (schema already allows docx; everything here generalizes,
  but extraction/rendering ships pdf-first).
- CLI/agent-initiated uploads into the brain.
- Byte-level version restore.
- OCR for scanned PDFs (extraction returns empty text → doc stays a viewable
  file with agent summary only from filename/context; flagged in the UI).
