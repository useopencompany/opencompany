# Folder State Architecture

Status: future concept

Created: 2026-06-04

## Executive Summary

The best long-term model is: Postgres owns the folder manifest and product
invariants, object storage owns large or binary bytes, and GitHub is a
versioned human-readable projection.

The important distinction is that "state in Postgres" should not mean "all file
contents in Postgres." A folder is product state: paths, current versions,
permissions, deleted markers, conflict decisions, runtime snapshots, and GitHub
sync status. File contents are bytes, and bytes can live in the cheapest and
most appropriate backing store.

OpenCompany should treat a workspace folder as a durable product object, not as
a Git checkout, not as an object-storage prefix, and not as a pile of database
text columns. The app needs fast reads, permissions, search, runtime mounting,
conflict detection, and clear sync status. GitHub remains important because it
gives customers visibility, history, portability, and trust, but it should not
be the low-latency source of truth for agent execution.

The thesis:

```text
Folder state is a database problem.
File bytes are a storage problem.
GitHub history is a projection problem.
```

## First Principles

A folder-as-state system has three different responsibilities:

1. Current desired state. The app needs to know what files exist now, what their
   paths are, which versions are current, who can see them, and which agents can
   mount them.
2. Bytes. File contents may be tiny Markdown, medium text, large PDFs, images,
   archives, generated artifacts, or future binary formats. These have very
   different storage and retrieval characteristics.
3. User-visible history and control. Customers want to see meaningful changes,
   audit commits, export files, and understand what the system changed on their
   behalf.

Trying to make one system solve all three creates bad tradeoffs:

- Postgres is excellent for metadata, permissions, transactions, indexes, and
  small text. It is not ideal as arbitrary blob storage.
- Object storage is excellent for bytes. It is not a relational state manager
  and does not provide atomic multi-file folder updates by itself.
- GitHub is excellent for user-visible history and portable text. It is not an
  operational database or a low-latency runtime dependency.

## Why Not Object-Storage First?

At first glance, using S3 or Tigris as the default folder state feels simpler: a
folder is a prefix, a file is an object, and the object key is the path.

That simplicity breaks down when the folder becomes a product surface.

Examples:

- Rename `brain/product/` to `brain/research/`.
- Mount a coherent file snapshot into an agent session.
- Detect that an agent edited a file whose base version changed.
- Delete a folder while preserving auditable history.
- Show which files failed to mirror to GitHub.
- Enforce workspace and agent-level access rules.
- Store derived PDF text while keeping the original PDF immutable.
- Commit a readable GitHub mirror without blocking the user save path.

Object storage can hold the bytes for those operations, but it should not decide
what the current folder is. A rename in object storage is usually copy/delete
work over many keys. A partial failure can leave split state unless a separate
manifest says what is authoritative. Once we add manifests, conditional writes,
version pointers, permissions, conflict handling, and indexes, we have rebuilt a
database beside object storage.

So the hard rule is:

```text
Object storage may store file versions.
Postgres decides which versions exist, which version is current, and what the folder means.
```

## Role Of Postgres

Postgres should own the canonical folder manifest.

This means Postgres is not the permanent home for every byte. It is the place
where product truth is made explicit and transactionally updated.

It should answer questions like:

- What files exist in this workspace?
- What is the current version of `brain/product/spec.md`?
- Is this file text, PDF, image, generated output, or deleted?
- What is the content hash?
- Where are the bytes stored?
- Which agent, session, or user last changed it?
- Has this version been mirrored to GitHub?
- What files belong to a coherent snapshot mounted into a session?

The real benefits are:

- Atomic updates across file metadata, version pointers, session events, and
  sync jobs.
- Fast folder listings without reading file bytes.
- Workspace-scoped authorization and queries.
- Exact current-version pointers.
- Conflict detection from base hash or version.
- Durable GitHub sync queue and per-file sync status.
- Coherent runtime snapshots.
- Cleanup of abandoned uploads and orphaned objects.
- Hooks for search, indexing, preview generation, and PDF extraction.

A future model could look conceptually like:

```text
workspace_files
- id
- workspace_id
- path
- kind
- mime_type
- current_version_id
- size_bytes
- content_hash
- text_encoding
- github_sync_status
- github_synced_version_id
- created_at
- updated_at
- deleted_at

workspace_file_versions
- id
- file_id
- workspace_id
- version
- content_hash
- size_bytes
- storage_backend
- storage_key
- inline_text_content
- created_by_type
- created_by_id
- created_at

workspace_snapshots
- id
- workspace_id
- manifest_hash
- created_by_type
- created_at

workspace_snapshot_files
- snapshot_id
- file_id
- file_version_id
- path
```

The exact schema can change, but the separation matters: file identity, current
path, versions, bytes, and snapshots are distinct concepts.

## Markdown Vs PDF

Markdown and PDFs should share one file-state model but use different byte and
processing paths.

### Markdown

Markdown is small, editable, diffable, searchable, and meaningful in Git.

For Markdown and other supported text files:

- Store metadata in Postgres.
- Store the current text inline in Postgres if it stays below a small threshold,
  or store it in object storage and cache hot text in Postgres.
- Compute a stable content hash from normalized bytes.
- Mirror the actual file content to GitHub.
- Use GitHub commits as a readable audit trail.
- Allow web editing and runner writeback.

This is close to today's Brain and agent bundle model, but generalized.

### PDF

PDFs are binary documents. They are not naturally editable in the app, not
useful as Git diffs, and may be much larger.

For PDFs:

- Store metadata in Postgres.
- Store bytes in object storage.
- Store MIME type as `application/pdf`.
- Store size, hash, page count if extracted, and derived text/index metadata if
  needed.
- Mirror a pointer or manifest file to GitHub, not necessarily the raw PDF.
- Optionally store extracted text as a separate derived artifact for search and
  agent context.

For example, GitHub might receive:

```yaml
path: brain/research/acme-10k.pdf
type: application/pdf
sizeBytes: 1843021
sha256: 4f7...
opencompanyFileId: file_123
version: 8
```

That preserves auditability without forcing GitHub to become large-file storage.

## Object Storage

Object storage should hold bytes that are too large, binary, immutable, or not
useful to keep inline in Postgres.

S3, Tigris, R2, or another S3-compatible system can serve this role. Tigris is
especially interesting if its snapshots or forks become useful for agent
experiments, evals, or isolated runtime branches. But even if Tigris is the byte
store, it should remain behind a storage-provider boundary. The product should
not depend on a bucket prefix being the authoritative folder model.

The storage key should be internal and stable, not directly derived from user
path alone. User paths can change; object versions should remain addressable.

Example:

```text
workspaces/{workspace_id}/files/{file_id}/versions/{version}
```

or content-addressed:

```text
sha256/{first_two_chars}/{sha256}
```

Object storage should be treated as byte storage only. Postgres should still be
the place that decides which object version is current, visible, deleted,
mounted, or synced.

For small text, inline Postgres content is still reasonable. It keeps the
interactive editor and runtime path simple. If the file grows or becomes binary,
the same file-version model can point to object storage instead.

## Runtime Mounting

Agent sessions should mount a Postgres-backed snapshot, not "whatever GitHub
currently has."

Flow:

1. Resolve the agent's Brain and bundle references from Postgres.
2. Create a manifest of file IDs and exact version IDs.
3. Fetch bytes from inline Postgres content or object storage.
4. Materialize files into the sandbox.
5. On writeback, validate path, type, size, count, and permissions.
6. Write new versions through Postgres and object storage.
7. Mark the workspace dirty for GitHub projection.

This gives each session a coherent view of state and prevents GitHub sync lag
from affecting runtime behavior.

## GitHub Projection

GitHub should remain, but as a projection.

For small text files:

- Commit the actual file.
- Keep paths readable.
- Use one coalesced commit per workspace sync.

For binary or large files:

- Commit pointer files, manifests, or extracted text where useful.
- Consider optional Git LFS only for customers who explicitly want clone
  fidelity.
- Keep large raw bytes in object storage by default.

For customer trust, the GitHub repo should eventually live under the customer's
GitHub installation or organization, not only under an OpenCompany-owned org.
That better matches the "company-owned agents and state" promise.

## Write Path

The ideal write path is:

1. User, agent, or runner writes a file.
2. The app validates path, type, size, and workspace permissions.
3. If small text, write content and metadata in one Postgres transaction.
4. If large or binary, upload bytes to object storage, then finalize the
   Postgres version record.
5. Mark the workspace folder dirty.
6. Return success to the user once canonical state is saved.
7. Asynchronously mirror the changed state to GitHub.

GitHub failure should show sync status, but should not make the file appear
unsaved in the app.

## Sync And Failure Model

GitHub sync should be durable and rate-aware:

- Use a workspace-level dirty job.
- Coalesce rapid edits.
- Recover stale `syncing` jobs with a lease timeout.
- Use a global GitHub write queue.
- Honor GitHub `retry-after` and rate-limit headers.
- Avoid whole-repo recursive tree reads.
- Reconcile only managed paths or compare against the last known managed
  manifest.

The invariant should be:

```text
Postgres/object storage can run the product without GitHub.
GitHub can lag, fail, or be repaired without corrupting canonical state.
```

And more specifically:

```text
Postgres can describe the folder without object bytes.
Object storage can serve bytes without owning product truth.
GitHub can explain changes without blocking the app.
```

## Recommended Direction

For the current product, keep the existing small-text model, but do not extend it
directly to arbitrary folder state.

The current Brain and agent bundle tables are acceptable for small UTF-8 files.
They should not become the general file system.

Next foundation step:

1. Harden current GitHub sync.
2. Add a generalized `workspace_files` / `workspace_file_versions` model.
3. Keep Markdown and `.agent` files first-class editable text.
4. Add object storage for PDFs and larger files, with Tigris as a strong
   candidate for that provider.
5. Mirror small text as real files to GitHub.
6. Mirror large or binary files as pointer manifests by default.
7. Later, offer customer-owned GitHub repos and optional LFS-style behavior.

This preserves the current product insight while removing the scaling trap:
GitHub remains the visible contract, object storage becomes the byte substrate,
and Postgres remains the place where folder truth is transactionally defined.
