# Architecture

OpenCompany has one product application. Chat and Task are the headless execution slice: `web` is
the Next.js client, `api` is the public HTTP composition root, and `runner` owns durable execution.
Unmigrated product domains continue to use the existing web/runner boundaries.

## Runtime boundaries

- `apps/web` owns the Next.js UI, authenticated server actions for unmigrated domains, public
  integration callbacks/webhooks, and the same-origin `/v1` proxy. Its ordinary-Chat compatibility
  route is rollback-only; it owns no canonical or coding-agent capability transport.
- `apps/api` owns the versioned Hono `/v1` Chat and Task API, WorkOS session/bearer authentication,
  authorization, canonical Auto model resolution, OpenAPI, semantic SSE, and authorized Electric
  read-model proxying.
- `apps/runner` owns durable chat/task turns, cloud coding sandboxes, in-process execution
  capabilities, the ticketed Claude MCP transport, Brain ingestion and import, integration
  polling/flush, schedules, dictation transport, billing usage, and the LLM broker.
- `apps/stripe-webhooks` is a local-only Stripe CLI process that forwards Goat billing events.
- `apps/marketing` is released independently from the product.

The detailed turn and message flow is maintained in [the OpenCompany system map](../apps/web/docs/README.md).
Operational topology and rollout gates are in [Headless Chat operations](./headless-chat-operations.md).

## Data

`packages/db/src/goat-schema.ts` is the current product schema. The Drizzle client composes it with
two narrow public-schema compatibility modules:

- `legacy-billing-schema.ts` preserves existing customer, subscription, credit, and webhook-event
  tables still written by Goat's billing compatibility path.
- `llm-broker-schema.ts` preserves token and usage tables used by the runner broker.

Those modules model existing tables; they are not a license to expand the retired product. Checked-in
migration history remains authoritative and is never rewritten. Web collections consume authorized
Electric shapes through its same-origin proxy.

## Durable execution

Goat creates durable sessions and turns in Postgres. Runner workers claim them with fenced leases,
heartbeat while executing, persist messages/events/artifacts/usage, and settle the projection
atomically. Current engine adapters support OpenCompany, Codex, and Claude Code. E2B provides
persistent coding sandboxes; Vercel Sandbox supports browser-capable foreground work.

## Integrations and security

WorkOS sessions authenticate the web app. OAuth state and integration credentials are signed/encrypted at
the application boundary. General runner routes remain private behind `RUNNER_INTERNAL_TOKEN`; its
public sandbox/browser transports accept only scoped signed capabilities. Provider keys remain
server-side; sandboxed CLIs use short-lived broker credentials or workspace-scoped injected auth.
