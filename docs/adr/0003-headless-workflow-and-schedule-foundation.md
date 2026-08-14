# ADR 0003: Final headless product boundary

- Status: Accepted and complete for issue
  [#1203](https://github.com/useopencompany/opencompany-experimental/issues/1203)
- Date: 2026-08-14
- Owners: API, web, runner, and shared-domain maintainers
- Supersedes: the temporary web-owned product and compatibility boundaries documented during the
  headless-core migration

## Context

OpenCompany originally composed product behavior in the Next.js application. Headless-core phases
1–4 established canonical Conversations, Messages, Runs, Tasks, Workflows, schedules, knowledge,
integrations, workspace settings, identity, and billing behind a versioned API while retaining the
runner as the durable execution authority.

The migration is complete. The production boundary must now describe the system operators and
contributors should build against, not a sequence of adapters that no longer exists.

## Decision

### Runtime ownership

OpenCompany has three product composition roots:

- `apps/web` is the presentation client. It owns Next.js rendering, browser state, the WorkOS
  browser-authentication shell, `activateGoatWorkspace`, static/health delivery, and narrowly scoped
  same-origin or public-URL continuity proxies. It does not own product persistence, authorization
  policy, provider credentials, provider ingress processing, schedulers, or AI execution.
- `apps/api` is the public product and provider-ingress composition root. It owns every versioned
  `/v1` resource, Actor/workspace derivation, authorization, identity persistence, OpenAPI, semantic
  SSE, API-owned Electric read models, OAuth state and exchanges, webhook verification, and backend
  product commands. Every `/v1` route authenticates its caller; the identity/onboarding escape hatch
  verifies the WorkOS identity before an onboarded Actor exists.
- `apps/runner` owns durable Run execution and recovery, due-schedule claims, ingestion and polling,
  sandboxes, engine continuity, and narrow authenticated worker transports. It composes shared
  application services and repositories directly and never depends on web availability or calls the
  public API for leases, heartbeats, settlement, or persistence.

Shared packages keep the modular-monolith boundary legible. `packages/protocol` owns validated wire
contracts and generated OpenAPI, `packages/core` owns framework-independent application behavior,
`packages/db` owns Postgres mappings and repositories, and existing packages such as
`packages/goat-agent`, `packages/goat-brain`, and `packages/billing` own reusable domain behavior.

### Web authentication shell

`apps/web/lib/auth.ts` preserves React `cache()` request semantics for its Server Component callers,
but resolves identity through the canonical API. The API owns `syncGoatUser`, membership adoption,
`completeGoatAuthentication`, and their persistence reads. The web WorkOS routes and
`activateGoatWorkspace` remain permanent residents because they re-seal the AuthKit browser session,
handle SSO/MFA redirects, and set presentation cookies; they are not product-data adapters.

### Commands and reads

Browser product writes use the generated `/v1` client. Create commands retain their established
idempotency keys and updates that require optimistic concurrency retain their expected versions.
Credential rows, provider SDK objects, physical table names, leases, and internal ledger fields do
not enter protocol DTOs.

Browser reads use versioned resources or fixed API-owned Electric models. Clients choose a public
name such as `chat-conversations-v1`, `tasks-v1`, `workflows-v1`, `brain-documents-v1`, or
`integration-accounts-v1`; the API fixes the physical table, projection columns, Actor/workspace
predicate, and allowed parameters. There is no generic web shape endpoint and no client-selected
table, column, or predicate.

### Workflow and schedule model

A workspace-owned Workflow is a reusable ordered definition with an optimistic version and a manual
or scheduled trigger. An actor-owned Recurring Task is scoped to the actor and current workspace.
Both manual and due invocations create canonical Tasks and Runs through `TaskApplicationService`;
there is no parallel Workflow runtime or queue. The runner is the only due-occurrence claimant.

Workflow and schedule commands remain available under `/v1/workflows` and `/v1/schedules`, with
fixed `workflows-v1`, `workflow-schedules-v1`, and `task-schedules-v1` read models. Existing
idempotency, optimistic-conflict, and tenancy semantics are permanent contract behavior.

### External ingress and URL continuity

Provider OAuth callbacks and webhooks are processed by the API or runner boundary with signed state,
tenant checks, encrypted credentials, raw-body signature verification, replay protection, and
idempotency. Where a provider still targets a historical web URL, the web route is a byte-preserving
or streaming continuity relay only; it owns no provider SDK, secret handling, or persistence.

### Persistence and compatibility

Postgres remains authoritative. Schema changes are additive Drizzle migrations; applied migration
history and retained physical compatibility names are never rewritten for cosmetic architecture.
Read-model projections are rebuildable, but source Conversations, Messages, Runs, Tasks, Workflows,
schedules, knowledge, integration state, credentials, and billing history are not.

The 35 known sessionless pre-cutover Tasks remain readable through the bounded actor-scoped
compatibility resources governed by ADR 0002. They are terminal and cannot be continued, canceled,
or archived. Their retention gate is independent of this boundary and they are not a web backend.

### Enforced web boundary

Production TypeScript under `apps/web` has zero `@opencompany/db` and zero `drizzle-orm` imports.
`scripts/check-web-domain-boundary.mjs` enforces zero directly in CI and also rejects the retired
Brain/import worker-control transports. There is no migration baseline or documented exception to
update. New product data access must be added to the canonical API or a shared service composed by
the API/runner.

## Consequences

- Web rendering cannot silently become a second backend through an RSC loader or Server Action.
- First-party browser, future native, and SDK clients share one authenticated product contract.
- API read models are safe to expose because clients cannot change their physical source or tenancy
  predicate.
- Runner recovery remains independent from HTTP and web deployments.
- Provider URL continuity may keep a thin web route, but ownership is determined by where state,
  verification, and policy execute.
- Physical compatibility schemas and historical data can outlive their former callers without
  weakening the runtime boundary.

## Operations

The system operates fix-forward. The legacy Chat route, rollout flag, bespoke Codex/Claude Message
routes, and generic web Electric selector are deleted. Incidents are corrected through the normal
protected release flow; no rollback adapter, dual write, or first-party compatibility path should be
reintroduced. A plain application revert remains available when safe, while additive migrations and
accepted canonical work remain in place.
