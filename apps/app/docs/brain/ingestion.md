# Brain Ingestion

How external content becomes brain documents. One durable pattern: normalize the source into a
`goat.brain_source_items` row, enqueue a `goat.brain_ingest_jobs` row, and let the runner's ingest
worker hand it to a registered handler — usually an agentic loop over the brain CLI.

## The shape

```text
Source (webhook, poller, chat tool)
  normalize → goat.brain_source_items        (idempotent on external_id + content_hash)
  enqueue   → goat.brain_ingest_jobs         (kind + brain_ref pinned at enqueue)

Runner (apps/runner/src/goat-brain-ingest-worker.ts)
  poll every 5s, claim with lease (TTL 5 min, heartbeat 5s, max 5 attempts)
  match job (kind, source_provider, source_type) → handler
  handler materializes the brain, runs, syncs writes back
```

Key properties:

- **`brain_ref` is pinned at enqueue.** Routing (e.g. `getDefaultGoatBrainForUser`) happens at the
  edge; the worker and handlers never resolve a brain themselves.
- **Handlers are matched by descriptor** — the `(kind, sourceProvider, sourceType)` triple in
  `GOAT_BRAIN_INGEST_HANDLERS` (`goat-brain-ingest-worker.ts`). Adding a pipeline means adding a
  descriptor + payload guard + run function there.
- **Payloads are validated on claim** with the `isNormalized*SourceItem` guards from
  `packages/goat-brain/src/source-items.ts`.

## Per-attempt spend gate

Agentic ingestion has a provider-spend circuit breaker in
`apps/runner/src/goat-brain-agent-ingest.ts`. Each claimed worker attempt has a 1,000,000 USD-micro
($1.00) soft limit and stops starting new model steps at 900,000 USD-micros, reserving the remaining
$0.10 for the request that just completed and concurrently executing tools. Because provider usage
is reported only after completion and tools may execute concurrently, an attempt can overshoot the
soft limit. Model output is also bounded per step. The gate includes:

- ingestion-model usage, priced from the shared billing catalog;
- semantic `goat_brain query` embeddings, reported by the CLI and priced from gateway usage;
- Exa enrichment searches, using provider-reported cost.

The final `brain_ingest_jobs.result` JSONB stores the budget limit, stop threshold, model/query/search
breakdown, total provider spend, accounting-complete flag, and exhaustion flag. The same data is
embedded in the normalized ingest trace. Budget exhaustion after valid mutations completes with the
valid changes and records `budget.exhausted = true`; exhaustion before any mutation fails terminally
and persists the failure trace instead of retrying another paid run. Unpriceable query usage also
fails terminally rather than silently bypassing the gate.

SigNoz receives `goat.brain_ingest_spend_usd_micros` by low-cardinality `goat.cost_source`,
`goat.brain_ingest_budget_exhaustions_total`, and the final spend/budget fields on the ingest root
span. The structured completion log carries the same fields for the configured log backend. Gateway
requests retain the `ingest:<job-id>` attribution tag for request-level investigation.

## Source items

`NormalizedBrainSourceItem` (`packages/goat-brain/src/source-items.ts`): provider, type,
`externalId` (dedupe key), `sourceRef` (`provider:id`, becomes the provenance pointer),
title, `occurredAt`/`capturedAt`, `contentHash` (stable-JSON sha256), and typed `content`.

Current providers/types:

| Provider | Type | Normalizer | sourceRef shape |
| --- | --- | --- | --- |
| `jamie` | `meeting` | `normalizeJamieMeetingCompletedWebhook` | `jamie:meeting:<externalId>` |
| `goat-chat` | `capture` | `normalizeGoatChatCapture` | `goat-chat:<userMessageId>` or the saved source's canonical ref |
| `slack`, `gmail`, `linear` | `pointer` | `normalizeGoatBrainPointerCapture` | canonical ref returned by the chat action |
| `google_drive` | `document` | `normalizeGoogleDriveDocument` | `google-drive:file:<fileId>` |

## Google Drive documents

Google Drive is a personal, ingestion-only Brain source. A workspace admin may attach only their
own Drive connection to brains they administer. Each source selects explicit files or recursive
folders from My Drive or Shared Drives; source configuration stores a server-controlled
`selectedAt`, and the initial Drive page token is persisted before the selection is saved. Existing
content is therefore not backfilled.

The runner maintains one durable change cursor for the user corpus and one for every selected
Shared Drive. Valid Drive notifications only wake these cursors—the notification body is never
treated as change data. Cursors reconcile at least every 15 minutes, while seven-day watch channels
renew with 24 hours remaining and deliberately overlap. Local HTTP development skips watch creation
and uses reconciliation polling.

Changed files debounce for five quiet minutes with a thirty-minute ceiling and use durable leases.
The worker rechecks the enabled source and current folder ancestry before download and fan-out. It
extracts supported Google-native and uploaded document formats without persisting raw binary,
normalizes one `google_drive/document` item, and enqueues `runGoogleDriveDocumentAgentIngest`.
Drive remains canonical, so the agent writes synthesized facts with a canonical pointer and never
creates an `evidence/` snapshot. Removal, moves out, deletion, and access loss stop future ingestion
without deleting existing Brain knowledge.

## Other pipelines

### 1. Jamie meetings (agentic — current path)

Jamie `meeting.completed` webhook → source item → job with `kind: brain_agent_ingest` →
`runJamieMeetingAgentIngest` (`apps/runner/src/goat-brain-agent-ingest.ts`).

An LLM loop drives the bundled `goat-brain` CLI (query, create, append-evidence, link, move,
merge) against a materialized copy of the brain. The system prompt embeds
`GOAT_BRAIN_POINTER_COPY_RULE`. Expected output per meeting:

- a meeting page in `meetings/`,
- a transcript snapshot as an evidence record under `evidence/` (Jamie transcripts are ephemeral,
  so they snapshot per the [pointer/copy contract](./pointer-copy-contract.md)),
- typed relations linking the meeting to participant/company pages, creating them if needed.

### 2. Explicit captures from chat or MCP (agentic)

Chat's `save_to_brain` tool (`apps/goat/lib/brain-capture.ts`) is available to every member with
access to an active brain. It is capture-first: it immediately
writes a **draft page in `inbox/`** (status `draft`) so the user sees the save instantly, then
records a source item and enqueues a `brain_agent_ingest` job. `runGoatChatCaptureAgentIngest`
later curates the draft: better title, entity type, target folder, links, promotion out of the
inbox, and merging with duplicate drafts. The draft's minted `brain_id` doubles as the source
item's `externalId` for dedupe.

When the save includes copied integration content plus `sourceRef`, both the draft and source item
cite that canonical Slack, Gmail, Linear, or URL ref instead of the chat message. Every successful
save reserves workspace ingestion credits, including saves made by non-admin members.

The user-level MCP server exposes the same capture path as `save_to_brain` for workspace admins.
MCP captures use an `mcp:` source ref so provenance and ingestion traces identify their origin;
they otherwise share the immediate-draft and background-curation behavior above.

### 3. Integration pointers (hydrate, then ingest)

A ref-only chat save for Slack, Gmail, or Linear records a `pointer` source item and enqueues a
`brain_pointer_hydrate` job with the provider integration id. The runner loads that credential,
re-fetches the full provider source, runs the existing provider normalizer, and delegates to the
existing Slack conversation, Gmail thread, or Linear issue agent-ingest profile. This avoids the
foreground action's display truncation while preserving the canonical source ref.

The immediate inbox draft still makes the save visible before the job runs. Transient provider
failures use the queue's existing retry/backoff behavior. A deleted or forbidden source is curated
from the optional short fallback; without one, the job is skipped as `pointer_source_unreachable`.
The pointer content hash is based on its canonical ref, so re-saving the same ref deduplicates
instead of forcing a fresh hydration.

### 4. Jamie meetings (legacy deterministic template — draining)

Jobs with `kind: brain_source_item_ingest` run `writeJamieMeetingToBrain`
(`apps/runner/src/goat-brain-jamie-writes.ts`): a no-LLM template writer with deterministic ids
(`meeting-{date}-{slug}-{hash}`, `ev-jamie-{hash}`). The handler stays registered only so
already-queued jobs drain; new Jamie webhooks enqueue the agentic kind.

## Related but different: `goat-brain ingest`

The CLI's `ingest` command is a one-shot LLM planner (graph-first brain changes from pasted
source text, `packages/goat-brain/src/ingest.ts`). It shares the pointer discipline but is not
part of the durable queue above — it runs wherever the CLI runs.
