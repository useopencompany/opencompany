# opencompany

opencompany is an AI workspace for conversations, durable tasks and workflows, connected tools,
shared Brain knowledge, and cloud coding sessions. It keeps interaction in the web app while the
work itself runs through a typed API and a durable background runtime.

[Open the hosted product](https://my.opencompany.chat) · [Read the system map](./docs/system-map.md)

## Three product runtimes

```text
Browser ── pages, auth, optimistic UI ──> apps/web
   │                                      │
   └──────── typed /v1 commands ──────────┴──> apps/api ──> Postgres
                                                   │             ▲
                                                   │             │
                                                   └─ control ─> apps/runner
                                                                 │
                                                                 └─ durable work
```

- `apps/web` is the Next.js presentation and authentication shell. It does not own product data or
  execution.
- `apps/api` is the authenticated `/v1` product boundary and provider-ingress composition root.
- `apps/runner` claims durable work from Postgres and owns background execution, integrations, and
  coding sandboxes. It does not depend on web availability.

Clients depend on `packages/protocol`; application behavior lives in `packages/core`; persistence
adapters live in `packages/db`. See [Architecture](./docs/architecture.md) for the full boundary.

## Community development

The community path needs Bun `1.3.2` and Node `20.20.0` or newer. It does not need access to
opencompany's Infisical, Neon, Vercel, or Render projects:

```bash
bun install --frozen-lockfile
bun run dev:community
```

That one run command starts an embedded, persistent PGlite database, applies migrations, and boots
web, API, and runner. In another terminal, verify both backend runtimes:

```bash
bun run smoke:local
```

The web app is normally at `http://localhost:3002`. Community mode deliberately disables WorkOS
sign-in, model execution, Electric live reads, billing, provider integrations, and hosted telemetry
until you supply your own provider configuration. The launcher and health responses report those
disabled capabilities explicitly.

This path is supported for development and contributions. It is **not** a production self-hosting
distribution or operations promise. See [Community development](./docs/community-development.md)
for limitations, reset instructions, and verification status.

## Internal development

Maintainers with opencompany provider access use branch-isolated Neon, Infisical, Electric, WorkOS,
and integration credentials:

```bash
bun install --frozen-lockfile
bun run setup
bun run dev:web
```

`bun run setup` creates or reuses the Neon branch for the current Git branch, applies migrations,
starts local Electric when available, and writes gitignored local environment files. See
[Getting started](./docs/getting-started.md) for prerequisites and troubleshooting.

## Repository layout

- `apps/web`, `apps/api`, `apps/runner` — the three product composition roots.
- `apps/docs` — public product and generated API documentation.
- `apps/marketing`, `apps/design-system`, `apps/stripe-webhooks` — separately deployed or local-only
  supporting applications.
- `packages/protocol`, `packages/core`, `packages/db` — wire contract, framework-free application
  behavior, and persistence adapters.
- `packages/*` — other reusable UI, agent, Brain, billing, telemetry, and integration behavior.
- `examples/api-client` — one typed `/v1` Conversation, Message, and Run-stream flow.
- `integrations` — provider deployment definitions, currently HubSpot.
- `drizzle` — immutable migration history.
- `docs` — contributor, architecture, operator, ADR, and future-decision sources.
- `scripts` — supported repository setup, verification, release, and documented maintenance tools.

Each primary app and boundary package has a local ownership README with allowed dependencies, stable
entry points, and focused verification commands.

## Contributing and checks

This is maintainer-led open source. Focused documentation, tests, bug fixes, small UX improvements,
and scoped integrations are welcome; high-risk design work needs prior agreement. Read
[CONTRIBUTING.md](./CONTRIBUTING.md) for where changes belong, DCO sign-off, and design approval.

```bash
bun run format:check
bun run lint
bun run typecheck
bun run build
bun run test
bun run db:migrations:check
bun run secrets:check
```

The repository is a Bun/Turborepo monorepo. Package manifests remain private unless a specific SDK
is intentionally prepared for publication.
