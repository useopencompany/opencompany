# Goat runner

`apps/runner` is the durable support service for Goat. It is a Bun/Fastify process deployed on
Render and started locally by `bun run dev:goat`.

## Responsibilities

- claim, heartbeat, recover, interrupt, and settle durable Goat chat/task turns;
- execute OpenCompany, Codex, and Claude Code engine adapters;
- manage persistent E2B coding sandboxes, credentials, skills, attachments, and artifacts;
- run Brain ingestion/import, integration poll/flush, and schedule workers;
- serve dictation, coding-workspace, action-gateway, and LLM-broker transports;
- meter model usage and expose release-aware health checks.

The runner does not own a separate product schema. It reads Goat tables plus the isolated
LLM-broker and billing compatibility tables through `@opencompany/db`.

## Entry points

`src/index.ts` builds the HTTP server and starts enabled workers. Goat-specific internal routes are
under `/internal/goat/*`; `/healthz` is public for Render and release checks. Private routes require
`RUNNER_INTERNAL_TOKEN`. Browser transports validate signed tickets and allowed Goat origins.

`RUNNER_GOAT_TASK_WORKER_ENABLED` controls the durable task worker. Worker concurrency, DB pool,
lease, and sandbox timeouts are documented beside their values in `.env.example` and `render.yaml`.

## Sandboxes and broker

E2B sandboxes receive task files, current managed skills, and scoped provider credentials. They do
not receive application database credentials or raw platform secrets. The LLM broker validates
short-lived tokens, applies provider/model scope, records usage, and forwards only to configured
upstreams. See [LLM token broker](./llm-token-broker.md).

## Verification

Run runner unit tests and typecheck, then exercise the real Goat path that wakes the touched worker.
For deployment changes, verify `/healthz` reports the expected release and create a representative
durable turn through Goat rather than calling worker internals alone.
