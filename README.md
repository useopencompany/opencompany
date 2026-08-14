# opencompany

OpenCompany is an AI workspace with chat, durable tasks and workflows,
connected integrations, Brain knowledge, and cloud coding sessions.

## Stack

The monorepo uses Bun and Turborepo. `web` is the Next.js App Router presentation client deployed
on Vercel, `api` is the Hono product API deployed on Render, and `runner` is the Fastify durable
execution service deployed on Render. Data lives in branch-isolated Neon Postgres and is accessed
through Drizzle by the API and runner. WorkOS provides authentication, Electric provides authorized
live read models, and Vercel AI Gateway fronts model providers.

## Quick start

```bash
bun install
bun run setup
bun run dev:web
```

`bun run setup` pulls development values from Infisical, creates or reuses a Neon branch tied to
the current Git branch, runs migrations, and writes local app env files. `bun run dev` and
`bun run dev:web` both start the OpenCompany web app, canonical API, runner, Stripe CLI webhook
forwarding, Electric, and the local HTTPS/tunnel support needed by integrations.

See [Getting started](./docs/getting-started.md) for prerequisites and troubleshooting.

## Repository layout

- `apps/web` — the OpenCompany Next.js presentation client and stable public relay surface.
- `apps/api` — the canonical typed API, application services, and provider ingress handlers.
- `apps/runner` — Goat background workers, durable turns, Brain ingestion, and cloud coding.
- `apps/stripe-webhooks` — local Stripe CLI forwarding for Goat billing.
- `apps/marketing` — the public marketing site.
- `apps/design-system` and `packages/ui` — shared UI development.
- `packages/db` — Goat schema plus isolated billing and LLM-broker compatibility schemas.
- `packages/goat-*` — Goat agent, Brain, observability, and wiki support.
- `drizzle` — immutable migration history.
- `scripts` — local setup, Neon branching, release, and operational checks.

## Quality gates

```bash
bun run format:check
bun run lint
bun run typecheck
bun run build
bun run test
bun run db:migrations:check
bun run secrets:check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the review and verification expectations.

## Documentation

- [OpenCompany system map](./apps/web/docs/README.md)
- [Getting started](./docs/getting-started.md)
- [Architecture](./docs/architecture.md)
- [Database and migrations](./docs/database.md)
- [Runner](./docs/runner.md)
- [Deployment](./docs/deployment.md)
- [Environment variables](./docs/env-vars.md)
- [Secret management](./docs/secret-management.md)
