# opencompany

The platform for running a company with AI: a shared chat surface backed by a company **Brain**
(a typed, evidence-linked knowledge base fed by your tools), background **tasks and workflows**,
and persistent **cloud coding agents** (Codex and Claude Code) — live at
[my.opencompany.chat](https://my.opencompany.chat).

Everything runs over one durable execution model: interactive chat streams from the web app, and
all background work — cloud coding chats, tasks, workflows, scheduled runs — flows through a single
per-session turn queue in Postgres that the runner claims, leases, and settles atomically. Three
chat engines share that queue: `opencompany` (in-process), `codex`, and `claude_code` (persistent
E2B sandboxes). See [docs/architecture.md](./docs/architecture.md) for the full map.

## Repo layout

Headless core, thin surfaces:

- `apps/app` — the Next.js product surface (`@opencompany/app`): auth, routes, Electric live-sync
  proxy, server actions, Stripe webhook. Its own LLM-facing system map lives at
  [apps/app/docs/README.md](./apps/app/docs/README.md).
- `apps/runner` — the long-lived Fastify execution service on Render: durable turn worker, Brain
  ingestion workers, scheduler, LLM broker, sandbox and coding-workspace transports.
- `packages/core` — the product engine: chat agent, action service, session/task/workflow domain
  services. Framework-free.
- `packages/brain` — the knowledge domain: document model, timelines, links, retrieval, and the
  sandbox CLI bundle.
- `packages/db` — Drizzle schema and query modules for Neon Postgres, plus the serverless and
  pooled clients.
- `packages/agent-runtime` — shared contracts: model catalog, action-gateway wire types, engine
  event normalization, schedule helpers.
- `packages/telemetry`, `packages/observability`, `packages/analytics` — OTel traces/metrics,
  structured logs and error capture, PostHog analytics.
- `packages/ui`, `packages/billing`, `packages/browser-tools`, `packages/crypto`,
  `packages/file-extract` — design system and supporting libraries.
- `apps/macos` — **opencompany Quick**, the native macOS menu-bar composer.
- `apps/marketing` — the marketing site. `apps/design-system` — UI component showcase.
- `apps/stripe-webhooks` — local dev shell that runs `stripe listen` against the app webhook.
- `scripts` — setup, env, Neon branching, and release automation. `drizzle` — checked-in
  migrations. `docs` — operational guides. `.claude/skills` — agent skills.

## Stack

Turborepo on Bun · Next.js (App Router) · Drizzle on Neon Postgres · ElectricSQL live sync ·
WorkOS AuthKit · Vercel AI Gateway · E2B sandboxes · Stripe billing · deployed on Vercel and
Render. The maintained technology register lives at [docs/stack/README.md](./docs/stack/README.md).

## Quick start

```bash
bun install
bun run setup
bun run dev
```

`bun run setup` is idempotent: it copies `.env.example`, pulls shared dev env vars from Infisical
when linked, creates or reuses a Neon branch for the current Git branch, runs migrations, starts a
local Electric container, and mirrors app-local values into `apps/app/.env.local`. `bun run dev`
starts the app plus the runner; with Caddy installed the app is served at `https://localhost:3443`.
See [docs/getting-started.md](./docs/getting-started.md) for the full walkthrough.

## Quality gates

Every PR runs on GitHub Actions: `format:check`, `lint`, `typecheck`, `build`, `test`, and
TruffleHog secret scanning. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the local commands.

## Docs

- [Getting started](./docs/getting-started.md) — new engineer checklist and local dev setup
- [Architecture](./docs/architecture.md) — the system map, execution model, and frozen storage
  contracts
- [Database](./docs/database.md) — Neon branching, schema changes, Drizzle
- [Runner](./docs/runner.md) — the execution service: workers, routes, scaling
- [Deployment](./docs/deployment.md) — production release flow, Vercel, Render, smoke checks
- [Environment variables](./docs/env-vars.md) — where every runtime and release env var lives
- [Secret management](./docs/secret-management.md) — Infisical source of truth and sync setup
- [Auth](./docs/auth.md) — WorkOS AuthKit, env vars, identity model
- [Observability](./docs/observability.md) — error capture, telemetry, and debugging
- [Technology stack](./docs/stack/README.md) — technology register, owners, replacement triggers
- [Future concepts](./docs/future-concepts/README.md) — speculative product and architecture notes
- [Contributing](./CONTRIBUTING.md)
