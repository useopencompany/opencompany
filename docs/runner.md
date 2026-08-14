# OpenCompany runner

`apps/runner` is OpenCompany's durable execution composition root. It is a Bun/Fastify process
deployed on Render and started locally by `bun run dev:web`.

## Responsibilities

- claim, heartbeat, recover, cancel, and settle durable Runs and Attempts;
- execute OpenCompany, Codex, and Claude Code engine adapters;
- manage persistent E2B coding sandboxes, credentials, skills, attachments, and artifacts;
- run Brain ingestion/import, integration poll/flush, and schedule workers;
- serve dictation, coding-workspace, ticketed Claude MCP, and LLM-broker transports;
- meter model usage and expose release-aware health checks.

The runner does not own a separate product schema. It reads Goat tables plus the isolated
LLM-broker and billing compatibility tables through `@opencompany/db`.

## Entry points

`src/index.ts` builds the HTTP server and starts enabled workers. Goat-specific internal routes are
under `/internal/goat/*`; `/healthz` is public for Render and release checks. Private routes require
`RUNNER_INTERNAL_TOKEN`. Browser and sandbox transports validate narrow signed tickets; Claude MCP
also rechecks persisted Conversation, Run, Attempt, lease, and membership authority for every
operation.

`RUNNER_GOAT_TASK_WORKER_ENABLED` controls the durable task worker. Worker concurrency, DB pool,
lease, and sandbox timeouts are documented beside their values in `.env.example` and `render.yaml`.

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

E2B sandboxes receive task files, current managed skills, and scoped provider credentials. They do
not receive application database credentials or raw platform secrets. The LLM broker validates
short-lived tokens, applies provider/model scope, records usage, and forwards only to configured
upstreams. See [LLM token broker](./llm-token-broker.md).

## Verification

Run runner unit tests and typecheck, then exercise the real product path that durably admits the
touched worker. For deployment changes, verify `/healthz` reports the expected release and Brain
worker admission capability version, then create representative work through the web or provider
path rather than calling worker internals alone.
