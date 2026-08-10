# Legacy product retirement

Issue [#1156](https://github.com/useopencompany/opencompany-experimental/issues/1156)
retires the first-generation `apps/web` product without changing the current Goat product's
names, storage contracts, or behavior. The work is split into independently deployable changes:

1. Completed in PR #1157: rescue the shared Stripe webhook into `apps/goat` and cut production
   traffic over safely.
2. Current phase: remove the legacy runner/session execution engine after confirming the durable
   Goat turn path owns every current execution entry point.
3. Remaining phase: delete `apps/web` and its remaining packages, workflows, setup paths, and
   operational docs.

No phase introduces a schema-drop migration. Existing rows and migration history remain readable.

## Responsibility inventory

| Area | Surviving owner | Decision and timing |
| --- | --- | --- |
| Current web product, chat, tasks, workflows, integrations, Brain, and billing UI | `apps/goat` | Keep. These are protected current-product flows. |
| Durable Codex/Claude chat turns, coding sandboxes, task schedules, integration polling/flush, Brain ingestion, and runtime access | Goat-specific routes and workers in `apps/runner` | Keep. Phase 2 removes only generic `.agent` sessions/jobs/tools and the superseded Goat task-message loop after tracing their callers. |
| Stripe webhook for Goat subscriptions, credits, and auto-refill | `apps/goat/app/api/stripe/webhook` | Moved in phase 1 with signature, tenancy, and idempotency coverage. The old route stays deployed until the dashboard cutover is verified. |
| Legacy-customer Checkout and auto-refill events delivered by the shared Stripe endpoint | `apps/goat/lib/billing/legacy-*` | Keep as isolated compatibility code. It continues to write the existing public-schema billing tables until active legacy customers are separately retired. |
| Local Stripe CLI forwarding | `apps/stripe-webhooks` and `scripts/stripe-listen.mjs` | Keep. `dev:goat` points it at Goat; the legacy dev command continues pointing at `apps/web` through the rollback window. Its default event set matches every Checkout outcome handled by both routes. |
| Current Goat database schema and migration history | `packages/db/src/goat-*` and existing Drizzle migrations | Keep. No destructive migration is part of this work. |
| Legacy billing tables needed by the compatibility webhook | Public-schema billing definitions in `packages/db` | Keep, then isolate during phase 3. Do not emit drop DDL. |
| LLM broker tables used by the runner | Public-schema broker definitions in `packages/db` | Keep and isolate during phase 3. |
| Generic `.agent` sessions, jobs, tool loop, Durable Streams, delegation, hosted/MCP tools, and old Goat task-message execution | Legacy portions of `apps/runner` | Deleted in phase 2. The durable session/turn lease, recovery, interrupt, managed-skill, credential-rotation, and artifact paths remain. |
| WhatsApp and message delivery | `apps/web` plus `packages/messaging` | Delete in phase 3 after the legacy app is no longer deployed. There is no Goat consumer. |
| File-backed legacy memory tools | Generic runner plus `packages/memory` | Runner execution path deleted in phase 2. The package remains only for `apps/web` and is deleted with that app in phase 3. Goat Brain remains in `packages/goat-brain`. |
| Legacy Inngest functions and local dev shim | `apps/web` plus `apps/inngest-dev` | Delete in phase 3. Current runner workers remain. |
| Shared runtime/database/analytics packages | `packages/agent-runtime`, `packages/db`, `packages/analytics` | Prune only exports without a surviving import. Keep current engine events, schedules, billing analytics, and compatibility schemas. |
| Legacy preview/release/deployment paths | Root workflows, scripts, Vercel configuration, and docs | Delete in phase 3 after the Stripe cutover. Keep Goat, runner, marketing, branch-isolated Neon, and release health checks. |

## Runtime consolidation boundary

Phase 2 traces the runner from `src/index.ts`, its HTTP routes, durable worker roots, and package
scripts. It retains:

- The durable `goat.codex_chat_turns` worker, including fenced lease heartbeats, crash recovery,
  deploy handoff, interruption, per-session FIFO, task settlement, and sandbox lifecycle.
- OpenCompany, Codex, and Claude engine adapters; generated chat artifacts; managed native skills;
  generation-safe Codex credential rotation; and Infisical keyring injection.
- Brain ingestion/import, integration polling and flush workers, schedules, coding-workspace and
  dictation transports, the LLM broker, billing usage, and runner health checks.

It removes the generic `agent_sessions` job queue and routes, model/tool loop, delegation,
Durable Streams publisher, hosted and MCP tool implementations, memory CLI bridge, legacy Codex
task executor, and the non-session Goat task-message drain. New tasks always use
`createGoatTaskSession`; pre-session task rows remain readable but cannot be continued.

There is no schema or migration change. The public-schema legacy rows remain intact. `apps/web`
still exists until phase 3, but its retired session endpoints no longer have a runner execution
owner; the Stripe rollback route remains available independently.

## Stripe production cutover

The route move is code-only and uses the existing database tables. Complete these steps before
deleting the old endpoint:

1. Copy the current production webhook signing secret into Infisical `prod` + `/goat` as
   `GOAT_STRIPE_WEBHOOK_SECRET`, then sync it to the Goat Vercel project. The release preflight
   deliberately fails if it is absent or is not a `whsec_` signing secret.
2. Confirm the restricted `GOAT_STRIPE_API_KEY` can read SetupIntents and PaymentMethods and update
   Customers. Those scopes preserve legacy setup-mode auto-refill events delivered to the shared
   endpoint.
3. Deploy Goat with `/api/stripe/webhook`. Send a signed test event for each subscribed family:
   Checkout completed/async success/async failure, subscription create/update/delete, invoice
   paid/failed, and PaymentIntent success/failure. Confirm Stripe receives `2xx` and that duplicate
   delivery does not create a second credit or subscription transition.
4. Edit the existing Stripe dashboard endpoint URL to the Goat production origin. Editing the
   existing endpoint preserves the signing secret and subscription list. Verify live delivery and
   Goat billing reconciliation before removing the old route.

If cutover verification fails, restore the endpoint URL to the still-deployed `apps/web` origin.
Both routes and both Vercel signing-secret variables remain available through the phase-1 rollback
window, and there is no database migration to reverse.

## Final removal checks

The last phase must include the deleted/retained matrix in its PR description, list the completed
Stripe cutover and any remaining manual smoke-test owners, and verify that operational searches for
`apps/web`, `@opencompany/web`, legacy runner routes, Inngest, messaging, memory, and preview paths
return no active references. Deliberate historical migration or changelog references should be
called out rather than rewritten.
