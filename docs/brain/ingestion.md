# Brain ingestion

External content enters Brain through one durable pattern: normalize a source item, commit an ingest
job pinned to a Brain, and let the runner claim and execute the matching handler.

```text
API command, verified provider ingress, runner poller, or agent capture
  -> goat.brain_source_items
  -> goat.brain_ingest_jobs

apps/runner
  -> poll and claim with a fenced lease
  -> validate (job kind, source provider, source type)
  -> run the registered handler
  -> commit Brain mutations and terminal job state
```

Postgres job state is the admission and recovery authority. Postgres notifications and authenticated
internal wake routes call the worker's in-process `notify()` path to reduce latency; they do not
carry source content, create jobs, or bypass polling and leases.

## Invariants

- `brain_ref` is resolved and authorized before enqueue, then persisted on the job. A worker never
  chooses a different Brain at execution time.
- `external_id` plus `content_hash` makes normalized source admission idempotent.
- Claimed payloads are checked with the typed guards in
  `packages/brain/src/source-items.ts` before a handler receives them.
- Handler registration is explicit in `BRAIN_INGEST_HANDLERS` in
  `apps/runner/src/brain-ingest-worker.ts`.
- Agentic handlers materialize one Brain into a temporary filesystem, run an allowlisted Brain CLI
  loop, and sync validated changes back. They do not make the filesystem canonical.

## Current source families

The registered handlers cover meeting sources (Jamie, Granola, and Fathom), explicit Chat/MCP
captures, uploaded assets, Google Drive documents, provider pointers (Slack, Gmail, and Linear),
provider activity or content (Slack, Gmail, Linear, GitHub, HubSpot, and Attio), and whole-Brain
imports. The exact `(kind, sourceProvider, sourceType)` registry in the runner is the source of truth;
update that registry, payload validation, and this overview together.

Canonical provider refs use `provider:id`. The normalizer preserves the provider's stable ID and
computes a content hash over bounded typed content. Provider credentials and raw webhook envelopes
stay behind API/runner boundaries and do not enter Brain documents or public read models.

## Capture from Chat and MCP

The shared capture service in `packages/agent/src/brain-capture.ts` writes an immediate draft in
`inbox/`, records a source item, and enqueues curation. opencompany Chat invokes it from the
runner-owned host-tool boundary; the API-owned MCP server exposes the same capture behavior to
authorized clients. Both pin the selected Brain and preserve canonical integration source refs.

The runner's curation handler may improve the title and entity type, move the draft, add sourced
relations, promote it, or merge it into an existing page. Chat and MCP callers do not receive raw
Brain mutation CLI commands.

Ref-only Slack, Gmail, and Linear captures use a pointer-hydration job. The runner loads the scoped
credential, refetches bounded provider content, validates it, and delegates to the provider's ingest
profile. A deleted or forbidden source is reported as unreachable rather than silently replaced
with unrelated content.

## Google Drive

Google Drive is a personal Brain source configured through authenticated `/v1` resources. A user
selects explicit files or recursive folders; the stored selection and change cursor determine what
may be ingested. The runner maintains durable change cursors for My Drive and selected Shared Drives,
renews watch channels, and reconciles by polling even when a notification is lost.

Drive remains the canonical home. Supported changed files are downloaded and extracted transiently,
then the ingest agent writes synthesized facts with a `google-drive:file:<fileId>` pointer. Moving a
file out of the selected tree, deleting it, or losing access stops later ingestion without erasing
knowledge already curated into Brain.

## Uploaded assets

The browser uploads through `POST /v1/brains/{brainId}/assets`. The API authorizes the Actor, stores
private bytes, creates or replaces the file-backed Brain document, and commits an upload ingest job.
The runner extracts supported text, updates the durable asset metadata, and runs the normal curation
agent. The API serves bytes through `/v1/brain-assets/{documentId}` after Brain authorization.

## Per-attempt spend gate

Agentic ingestion enforces a provider-spend circuit breaker in
`apps/runner/src/brain-agent-ingest.ts`. The result records the limit, stop threshold,
model/query/search breakdown, total provider spend, accounting completeness, and exhaustion state.
If the limit is reached after valid mutations, the job may commit those valid changes and report
exhaustion; if no valid mutation exists, it fails terminally instead of starting another paid
attempt. Unpriceable usage also fails closed.

Spend and exhaustion telemetry uses low-cardinality dimensions. Request-level investigation uses
the job ID in traces rather than source text or provider payloads.

## CLI distinction

`opencompany-brain ingest` is a one-shot planner over a local filesystem root. Runner agentic jobs may use
the same CLI against their materialized root, but the command itself is not a queue or public ingest
endpoint.
