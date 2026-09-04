# opencompany runner

`apps/runner` is opencompany's durable execution composition root. It is a Bun/Fastify process
deployed on Render and started locally by `bun run dev:web`.

## Responsibilities

- claim, heartbeat, recover, cancel, and settle durable Runs and Attempts;
- execute opencompany, Codex, and Claude Code engine adapters;
- manage persistent E2B coding sandboxes, credentials, skills, attachments, and artifacts;
- run Brain ingestion/import, integration poll/flush, and schedule workers;
- serve dictation, coding-workspace, ticketed Claude MCP, and LLM-broker transports;
- meter model usage and expose release-aware health checks.

The runner does not own a separate product schema. It reads opencompany tables plus the isolated
LLM-broker and billing compatibility tables through `@opencompany/db`.

## Entry points

`src/index.ts` builds the HTTP server and starts enabled workers. opencompany-specific internal routes are
under `/internal/goat/*`; `/healthz` is public for Render and release checks. Private routes require
`RUNNER_INTERNAL_TOKEN`. Browser and sandbox transports validate narrow signed tickets. The shared
Codex and Claude Code MCP gateway rechecks persisted Conversation, Run, Attempt, lease, membership,
and workspace Wiki authority for every operation; Wiki commands cross the canonical API
boundary instead of reading the Wiki database from the runner.

`RUNNER_OPENCOMPANY_TASK_WORKER_ENABLED` controls the durable task worker. Worker concurrency, DB pool,
lease, and sandbox timeouts are documented beside their values in `.env.example` and `render.yaml`.
Managed E2B sandboxes carry `RUNNER_SANDBOX_NAMESPACE`; reconciliation lists only its exact
namespace, preventing a local runner that shares E2B credentials from selecting production sandboxes.

## Worker admission

Runs, due schedules, Brain import, Brain ingestion, Google Drive sync, and integration work are
admitted by committed Postgres rows. Database triggers publish a versioned Postgres notification containing only the
worker kind; the runner keeps one dedicated listener connection and maps that hint to the existing
worker's in-process `notify()` callback. Notifications are a latency optimization, not a queue or a
claim. Each worker's polling loop remains active and authoritative for retry timing, fenced leases,
per-Brain serialization, Drive cursor ordering, and crash recovery. A dropped notification or
listener outage therefore delays work only until the normal poll, and the listener reconnects
without changing execution semantics.

Private Brain import/ingest and Drive wake routes expose the same latency hint for authorized
internal callers. They do not admit work, bypass claims, or replace polling, and first-party web
product flows do not call them.

## Sandboxes and broker

E2B sandboxes receive task files, exact immutable Skill bundles and Plugin packages captured by the
Chat or Workflow Task, and scoped provider credentials. Workflow steps without a `skillBundleIds`
array fail closed instead of loading a pre-cutover snapshot. Approved stdio MCP servers are mounted
only for the exact approved Plugin integrity in Codex and Claude coding sandboxes. Main Chat does
not launch Plugin MCP.

The runner restores and checkpoints bounded `PLUGIN_DATA` archives through Blob storage without
putting `BLOB_READ_WRITE_TOKEN` or other platform secrets in a Plugin process environment.
Sandboxes do not receive application database credentials or raw platform secrets. The LLM broker
validates short-lived tokens, applies provider/model scope, records usage, and forwards only to
configured upstreams. See [LLM token broker](./llm-token-broker.md).

## Chat attachment retention

The API gives each unclaimed chat attachment a 24-hour TTL. Keyed uploads reserve their key before
Blob I/O and replay the original attachment ID and expiry. Claimed and cleaned commands remain as
tombstones for 24 hours, so immediate retries return a conflict instead of giving the same key a
new meaning. The worker then purges the tombstone; a later reuse creates a new upload generation.

The task-worker group owns the attachment cleanup poller. It starts immediately, runs hourly, and
requires the runner's existing `BLOB_READ_WRITE_TOKEN`. One runner holds a Postgres advisory lock
per pass. Each pass handles at most 100 Blob-cleanup candidates and 100 command tombstones, and runs
again immediately after either batch is full. Physical deletion starts 15 minutes after expiry.
This grace does not make an upload claimable after its 24-hour TTL.

The cleaner locks and rechecks each candidate in its own transaction. Message creation marks a
keyed command terminal when it claims the upload, removing it from the partial cleanup index.
Claimed uploads are never Blob-cleanup candidates. The worker deletes Blob first, then removes the
unclaimed upload row and marks a keyed command cleaned. A separate partial index lets it purge
terminal command tombstones without scanning active reservations. A missing Blob counts as
success. Any other storage failure rolls back the candidate's database changes and leaves it for a
later poll. Completion and failure logs contain counts and opaque attachment or command IDs only.

Before enabling cleanup in production, run this read-only inventory query against the product
database:

```sql
SELECT
  count(*)::bigint AS expired_unclaimed_count,
  CURRENT_TIMESTAMP - min(expires_at) AS oldest_expired_age
FROM goat.chat_attachment_uploads
WHERE claimed_at IS NULL
  AND expires_at <= CURRENT_TIMESTAMP;
```

After deployment, verify `opencompany.chat_attachment_cleanup_completed` and
`opencompany.chat_attachment_upload_replayed` events. Roll back the API and worker before dropping
the additive command table. Blob cleanup is not reversible, but it only removes uploads that the
existing API already treats as unavailable.

## Verification

Run runner unit tests and typecheck, then exercise the real product path that durably admits the
touched worker. For deployment changes, verify `/healthz` reports the expected release and Brain
worker admission capability version, then create representative work through the web or provider
path rather than calling worker internals alone.
