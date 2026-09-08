# Architecture

opencompany is a modular monolith with three product composition roots: `web` presents the product,
`api` owns the public product boundary, and `runner` owns durable execution and background work.

## Runtime boundaries

- `apps/web` owns the Next.js UI, Server Component composition, optimistic browser state, WorkOS
  browser-authentication routes, `activateWorkspace`, health/static delivery, and narrow
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
[the opencompany system map](./system-map.md). Operational behavior is in
[Chat operations](./chat-operations.md), and the permanent ownership decision is
[ADR 0003](./adr/0003-headless-workflow-and-schedule-foundation.md).

## Technology stack

| Area | Technology | Responsibility |
| --- | --- | --- |
| Monorepo | Bun, Turborepo | dependency management and task orchestration |
| Presentation | Next.js, React | product UI and browser-authentication shell |
| Product API | Bun, Hono | authenticated `/v1` resources, provider ingress, SSE, OpenAPI, and read models |
| Durable execution | Bun, Fastify | workers, sandboxes, recovery, and internal transports |
| Database | Neon Postgres, Drizzle | branch-isolated state and checked-in migrations |
| Live data | Electric, TanStack DB | authorized API-owned read models |
| Authentication | WorkOS AuthKit | browser sessions and API identity |
| Models | Vercel AI Gateway, AI SDK | runner model access and API-owned Auto routing |
| Sandboxes | E2B, Vercel Sandbox | cloud coding and browser-capable workspaces |
| Hosting | Vercel, Render | web, docs, and marketing on Vercel; API and runner on Render |
| Secrets | Infisical | development and production environment authority |
| Observability | Better Stack, Sentry, SigNoz, Latitude | errors, logs, traces, and LLM telemetry |

## Data and client boundary

`packages/db/src/product-schema.ts` is the current product schema. The Drizzle client also composes two
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

opencompany creates durable Runs in Postgres. Runner workers claim them with fenced leases,
heartbeat while executing, persist Messages, Events, artifacts, approvals, and usage, and settle the
projection transactionally. opencompany, Codex, and Claude Code are engines on the same canonical
Conversation/Message/Run protocol.

Brain import, Brain ingestion, Google Drive sync, polling, and schedules follow the same admission
principle: database state is authoritative, notifications reduce latency, and fenced claims provide
recovery. The runner never calls the public API for execution persistence.

## Wiki ingestion

Provider ingress validates and normalizes source events before polling providers or buffering
activity windows. The Wiki is the default knowledge system and its source rows drive new ingestion.
The retained Brain pipeline is a reversible legacy path: workspace UI, agent tools, source routing,
enqueueing, and worker claims require `workspaces.legacy_brain_enabled`. Source configuration stays
separate so an intentional rollback can restore it, while operations disable legacy `brain_sources`
after cutover to stop provider polling. A leased runner worker then cheaply triages Gmail items
before the librarian applies page mutations through the same authorized Wiki tool used by
interactive agents; job results retain the outcome and touched page paths for ingestion activity.

## Agent Skills and Plugins

Agent Skills and Agent Plugins are immutable workspace artifacts. The API resolves and validates a
public GitHub or skills.sh source, stores the exact files and resolved commit, and moves a small
installation record when an admin replaces a standalone Skill. Plugins keep their own immutable
package, valid immediate-child Skills, install report, and optional stdio MCP declarations.

A Chat snapshots bundle and plugin IDs instead of names; a Workflow Task stores exact
`skillBundleIds` on every step and its exact plugin IDs in the Harness spec. The runner mounts those
versions even if workspace settings later change. Standalone Skills win name collisions with Plugin
Skills, and Plugin collisions resolve deterministically by Plugin name. Archived artifacts remain
available while a durable snapshot references them.

Installing a Plugin never grants execution. An admin separately approves the exact package
integrity before its stdio MCP servers can run, and MCP is available only in Codex and Claude coding
sandboxes. Writable `PLUGIN_DATA` is archived per workspace and Plugin name so it survives sandbox
and Plugin replacement. Brain's historical `skills/` pages and the dropped `goat.skills` tables are
not compatibility inputs or replay sources.

## Integrations and security

OAuth state and integration credentials are signed or encrypted at the backend boundary. Historical
public callback/webhook URLs may terminate at a thin web relay, but verification, tenant binding,
replay protection, idempotency, credentials, and persistence live in API/runner code.

General runner routes remain private behind `RUNNER_INTERNAL_TOKEN`; browser-reachable runner
transports accept scoped signed capabilities. Provider keys remain server-side, and sandboxed CLIs
use short-lived broker credentials or workspace-scoped injected auth. Credential columns and raw
tokens never enter client DTOs or logs.
