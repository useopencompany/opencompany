# Architecture

OpenCompany is a modular monolith with three product composition roots: `web` presents the product,
`api` owns the public product boundary, and `runner` owns durable execution and background work.

## Runtime boundaries

- `apps/web` owns the Next.js UI, Server Component composition, optimistic browser state, WorkOS
  browser-authentication routes, `activateGoatWorkspace`, health/static delivery, and narrow
  same-origin or provider-URL continuity proxies. It owns no product persistence or execution.
- `apps/api` owns authenticated `/v1` resources for Chat, Tasks, Workflows, schedules, Brain, Wiki,
  Skills, integrations, workspace/identity settings, onboarding, billing, usage, feedback, and MCP.
  It also owns authorization, OpenAPI, semantic SSE, fixed Electric read models, and provider OAuth
  and webhook processing behind any retained URL relay.
- `apps/runner` owns durable chat/task turns, cloud coding sandboxes, in-process capabilities, Brain
  ingestion/import, integration polling/flush, due schedules, dictation transport, usage settlement,
  and the LLM broker. It composes repositories directly and does not depend on web availability.
- `apps/stripe-webhooks` is a local-only Stripe CLI process that forwards test billing events.
- `apps/marketing` is released independently from the product.

The detailed product flow is maintained in
[the OpenCompany system map](../apps/web/docs/README.md). Operational behavior is in
[Headless Chat operations](./headless-chat-operations.md), and the permanent ownership decision is
[ADR 0003](./adr/0003-headless-workflow-and-schedule-foundation.md).

## Data and client boundary

`packages/db/src/goat-schema.ts` is the current product schema. The Drizzle client also composes two
narrow public-schema compatibility modules:

- `legacy-billing-schema.ts` preserves existing customer, subscription, credit, and webhook-event
  tables still used behind the billing application boundary.
- `llm-broker-schema.ts` preserves token and usage tables used by the runner broker.

Those modules model retained physical contracts; they are not a license to expand retired product
paths. Applied migrations remain authoritative and are never rewritten.

Browser writes use the generated `/v1` client. Browser reads use versioned API resources or fixed,
authorized API-owned Electric read models. The API selects each model's physical table, columns,
Actor/workspace predicate, and allowed parameters; the browser cannot select physical storage.

Production code in `apps/web` must have zero direct `@opencompany/db` and `drizzle-orm` imports.
`scripts/check-web-domain-boundary.mjs` enforces this final rule in CI with no baseline or exception
list. API and runner composition roots continue to use shared application services and repositories.

## Identity and durable execution

WorkOS authenticates browser sessions. The web auth shell manages framework-specific redirects,
session re-sealing, and workspace activation; the API owns identity synchronization, membership
adoption, Actor/workspace resolution, and product persistence. The cached web identity resolver calls
the API so Server Components retain one request-scoped result without creating a second data path.

OpenCompany creates durable Runs in Postgres. Runner workers claim them with fenced leases,
heartbeat while executing, persist Messages, Events, artifacts, approvals, and usage, and settle the
projection transactionally. OpenCompany, Codex, and Claude Code are engines on the same canonical
Conversation/Message/Run protocol.

Brain import, Brain ingestion, Google Drive sync, polling, and schedules follow the same admission
principle: database state is authoritative, notifications reduce latency, and fenced claims provide
recovery. The runner never calls the public API for execution persistence.

## Integrations and security

OAuth state and integration credentials are signed or encrypted at the backend boundary. Historical
public callback/webhook URLs may terminate at a thin web relay, but verification, tenant binding,
replay protection, idempotency, credentials, and persistence live in API/runner code.

General runner routes remain private behind `RUNNER_INTERNAL_TOKEN`; browser-reachable runner
transports accept scoped signed capabilities. Provider keys remain server-side, and sandboxed CLIs
use short-lived broker credentials or workspace-scoped injected auth. Credential columns and raw
tokens never enter client DTOs or logs.
