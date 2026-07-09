# Goat Brain Ingestion

How external content becomes brain documents. One durable pattern: normalize the source into a
`goat.brain_source_items` row, enqueue a `goat.brain_ingest_jobs` row, and let the runner's ingest
worker hand it to a registered handler — usually an agentic loop over the brain CLI.

## The shape

```text
Source (webhook, chat tool)
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

## Source items

`NormalizedBrainSourceItem` (`packages/goat-brain/src/source-items.ts`): provider, type,
`externalId` (dedupe key), `sourceRef` (`provider:id`, becomes the provenance pointer),
title, `occurredAt`/`capturedAt`, `contentHash` (stable-JSON sha256), and typed `content`.

Current providers/types:

| Provider | Type | Normalizer | sourceRef shape |
| --- | --- | --- | --- |
| `jamie` | `meeting` | `normalizeJamieMeetingCompletedWebhook` | `jamie:meeting:<externalId>` |
| `goat-chat` | `capture` | `normalizeGoatChatCapture` | `goat-chat:<userMessageId>` |

## The three pipelines

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

### 2. Chat captures (agentic)

Chat's `save_to_brain` tool (`apps/goat/lib/brain-capture.ts`) is capture-first: it immediately
writes a **draft page in `inbox/`** (status `draft`) so the user sees the save instantly, then
records a source item and enqueues a `brain_agent_ingest` job. `runGoatChatCaptureAgentIngest`
later curates the draft: better title, entity type, target folder, links, promotion out of the
inbox, and merging with duplicate drafts. The draft's minted `brain_id` doubles as the source
item's `externalId` for dedupe.

### 3. Jamie meetings (legacy deterministic template — draining)

Jobs with `kind: brain_source_item_ingest` run `writeJamieMeetingToBrain`
(`apps/runner/src/goat-brain-jamie-writes.ts`): a no-LLM template writer with deterministic ids
(`meeting-{date}-{slug}-{hash}`, `ev-jamie-{hash}`). The handler stays registered only so
already-queued jobs drain; new Jamie webhooks enqueue the agentic kind.

## Related but different: `goat-brain ingest`

The CLI's `ingest` command is a one-shot LLM planner (graph-first brain changes from pasted
source text, `packages/goat-brain/src/ingest.ts`). It shares the pointer discipline but is not
part of the durable queue above — it runs wherever the CLI runs.
