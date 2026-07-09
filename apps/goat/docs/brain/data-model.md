# Goat Brain Data Model

Source of truth for the brain's enums, grammars, document anatomy, and database tables. Every
value here mirrors a constant in `packages/goat-brain/src/schema.ts`; if this page and that file
disagree, the code wins and this page has a bug. Update them together.

## Kind: `page` vs `evidence`

`GOAT_BRAIN_KINDS = ["page", "evidence"]`

| Kind | Meaning | Folder rule |
| --- | --- | --- |
| `page` | User/agent-owned knowledge. Compiled truth is rewritten as understanding improves. | Any folder **except** the evidence zone. |
| `evidence` | Immutable sourced snapshot (a transcript, an email, a captured artifact). Pages cite it; nothing rewrites it. | Must live in `evidence/` or an `evidence/*` subfolder. |

Kind is **derived from the folder**, not chosen independently: `goatBrainKindForFolder(folder)`
returns `evidence` iff the folder is `evidence` or starts with `evidence/`
(`GOAT_BRAIN_EVIDENCE_ZONE = "evidence"`). The database enforces the same invariant with a check
constraint on `goat.brain_documents`.

## Entity types (the 8-type contract)

`GOAT_BRAIN_ENTITY_TYPES` — a **closed set**. Types are tags for what a document *is*; folders are
free-form navigation for where it *lives*. Don't add a type without updating schema.ts, the DB
check constraint, and this page. Retired v1 names still parse through legacy aliases:
`media` and `email` normalize to `source`, and `writing` normalizes to `analysis`.

| Type | Typical use | Suggested default folder |
| --- | --- | --- |
| `person` | A human — colleague, contact, participant | `people/` |
| `company` | An organization | `companies/` |
| `analysis` | Research output, synthesis, report | `analysis/` |
| `concept` | Idea, framework, definition | `concepts/` |
| `note` | Unstructured note, quick capture | `inbox/` |
| `project` | An initiative with a lifecycle | `projects/` |
| `source` | External artifact/reference: article, video, email thread, repo, document, source record | `sources/` (snapshot: `evidence/`) |

Validation: `isValidGoatBrainEntityType` (set membership).
Normalization: `normalizeGoatBrainEntityType` (lowercase, `[^a-z0-9]` → `_`, max 64 chars).
The looser `GOAT_BRAIN_ENTITY_TYPE_PATTERN` (`^[a-z][a-z0-9_]{0,63}$`) only bounds the shape;
the closed set above is what validators actually accept.

## Status lifecycle

`GOAT_BRAIN_STATUS_VALUES = ["draft", "active", "archived", "merged"]`

| Status | Meaning |
| --- | --- |
| `draft` | Captured but not yet curated. Chat captures land in `inbox/` as drafts. |
| `active` | Curated, trusted knowledge. **Promotion to `active` requires the compiled truth to cite at least one `[[evidence:...]]` link** (enforced by `goat-brain set`). |
| `archived` | Kept for history, excluded from default retrieval. |
| `merged` | Superseded by another document; frontmatter `mergedInto` names the survivor. |

## Default folders

`DEFAULT_GOAT_BRAIN_FOLDERS` — the 10 folders seeded per brain. `inbox`, `people`, `companies`,
and `evidence` are required system folders; the rest are adjustable custom defaults. Users and
agents can create free-form custom folders beyond these:

```
inbox/  thoughts/  projects/  meetings/  research/  decisions/
concepts/  people/  companies/  evidence/
```

Folder paths match `GOAT_BRAIN_FOLDER_PATTERN`: lowercase `a-z0-9-` segments separated by `/`,
at most 6 segments (e.g. `team/gtm`, `projects/launch`, `evidence/document`). `evidence/` is the
reserved zone (see Kind above).

## Identifier and reference grammars

| Thing | Pattern | Notes |
| --- | --- | --- |
| Document id (`brain_id`) | `^[a-z0-9][a-z0-9-]{0,79}$` | Slug, max 80 chars. `normalizeGoatBrainId` lowercases, strips quotes, collapses non-alphanumerics to `-`. |
| Evidence id | `^ev-[a-z0-9][a-z0-9-]{0,76}$` | Evidence records and timeline entries carry `ev-*` ids. |
| Source ref | `^[a-z0-9][a-z0-9-]{0,63}:[^\s[\]|]+$`, ≤ 256 chars | `provider:id`. The id part may itself contain colons/slashes: `jamie:meeting:calendar_event_123` is provider `jamie`, id `meeting:calendar_event_123`. Parse with `parseGoatBrainSourceRef`. |
| Relation type | `^[a-z][a-z0-9_]*$` | Default `related`. Free-form beyond the pattern (e.g. `owner`, `about`, `works_at`). |
| Inline link | `[[kind:target]]` or `[[kind:target\|Label]]` | `kind` is `page`, `evidence`, or `source` (`GoatBrainInlineLinkKind`, `inline-links.ts`). Bare `[[target]]` is a legacy page link. |

### brain_ref vs brain_id

Easy to confuse, deliberately distinct:

- **`brain_ref`** — foreign key to `goat.brains.id`. *Which brain.* Every read, job, and tool call
  is pinned to exactly one.
- **`brain_id`** — the document's slug within that brain (e.g. `ada`, `opencompany`). *Which doc.*
  Unique per brain, not globally.

## Document anatomy

A document is Markdown with YAML frontmatter and two well-known sections
(`GOAT_BRAIN_TRUTH_HEADING`, `GOAT_BRAIN_TIMELINE_HEADING` in `document.ts`):

```markdown
---
id: ada
folder: people
kind: page
type: person
status: active
createdAt: 2026-07-01T09:00:00Z
updatedAt: 2026-07-08T14:30:00Z
title: Ada
aliases: ["Ada L."]
tags: []
relations:
  - { type: works_at, to: opencompany }
sources:
  - { ref: "jamie:meeting:evt_123", capturedAt: 2026-07-01T09:00:00Z, title: "Kickoff" }
---

## Compiled truth

Ada leads GTM at [[page:opencompany|OpenCompany]]. Confirmed in the kickoff
meeting [[evidence:ev-jamie-abc123]].

## Timeline

- ev-jamie-abc123 2026-07-01 — Kickoff meeting: Ada introduced as GTM lead.
```

- **Frontmatter** — the full field contract is `GoatBrainFrontmatter` in `schema.ts`: required
  `id`, `folder`, `kind`, `type`, `status`, `createdAt`, `updatedAt`, `relations`; optional
  `title`, `aliases`, `tags`, `sources`, `mergedInto`, `legacyKeys`.
- **Compiled truth** — the current state of knowledge, rewritten in place (`goat-brain rewrite`).
- **Timeline** — append-only dated entries, each with an `ev-*` id and optionally a source ref.
  History is never rewritten; the truth section is recompiled *from* it.

## Binary assets (PDF)

`format` on the document row is `markdown` (default), `pdf`, or `docx`
(`GoatBrainDocumentFormat`). A binary-backed document is **one row, one folder entry, one
artifact** — there is no sibling "stub page":

- The bytes live in the private Vercel Blob store behind `asset_storage_key`;
  `original_file_name`, `mime_type`, `asset_size_bytes`, and `asset_content_hash` (sha256 of the
  bytes) describe them. The UI serves them through `/api/brain-assets/[documentId]` and renders
  the file first-class, with metadata and the agent's summary in the details sidebar.
- The `content` column still holds a normal markdown projection (frontmatter + compiled truth +
  timeline), so metadata, relations, wiki links, versioning, and sync work identically to
  markdown pages. The asset linkage is a `sources` entry with the `upload:<documentId>` ref.
- `asset_extracted_text` carries the machine-extracted text (capped at 200KB), written by the
  upload ingestion worker. Materialization appends it to the projection file as a generated
  block between `ASSET-TEXT:BEGIN/END` sentinels; the document parser strips that block, so the
  CLI and sync ignore it and edits inside it are discarded. Retrieval indexes it as the
  low-boost `assetText` field.
- Uploads enter via drag-drop / the upload button in the brain tree
  (`uploadGoatBrainAssetAction`), which creates the draft row and enqueues a
  `brain_agent_ingest` job (provider `upload`, type `asset`). The runner extracts the text, then
  the standard ingestion agent rewrites the page's compiled truth and wires backlinks. Deleting
  the document best-effort deletes the blob; version rows keep the page, not the bytes.

## Database tables

All in the `goat` Postgres schema, defined in `packages/db/src/goat-schema.ts`. Everything
brain-scoped carries a `brain_ref`.

| Table | Drizzle export | Holds |
| --- | --- | --- |
| `brains` | `goatBrains` | Brain metadata: workspace, name, slug, visibility, creator. |
| `brain_members` | `goatBrainMembers` | Per-brain membership/access. |
| `brain_folders` | `goatBrainFolders` | Folder rows per brain (`source: system \| custom`). |
| `brain_documents` | `goatBrainDocuments` | The documents: content, folder_path, kind, entity_type, status, sources, relations, format. Check constraints enforce the kind↔folder zone rule and the enum values above. |
| `brain_timeline_entries` | `goatBrainTimelineEntries` | Append-only timeline rows (evidence_id, at, source_ref, summary, detail). |
| `brain_edges` | `goatBrainEdges` | Derived graph edges from relations and wiki-links (`source_kind: relation \| wiki_link`). |
| `brain_document_versions` | `goatBrainDocumentVersions` | Version history (`operation: overwrite \| delete`). |
| `brain_source_items` | `goatBrainSourceItems` | Normalized external captures awaiting/after ingestion (see [ingestion.md](./ingestion.md)). |
| `brain_ingest_jobs` | `goatBrainIngestJobs` | The ingest job queue (lease, attempts, status). |
| `brain_tool_runs` | `goatBrainToolRuns` | Audit rows for brain tool invocations. |

Documents are materialized to a temp filesystem root for CLI access via
`materializeGoatBrainFilesToRoot` (`packages/db/src/goat-brain-files.ts`) — there is no persistent
file tree; the rows are canonical.
