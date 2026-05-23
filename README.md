# opencompany

An open platform for running AI agents inside a company.

Agents are **plain-text files** — Markdown with a small YAML header — versioned in a GitHub repo per workspace. The web app is the editor and the operations layer. GitHub is the source of truth. Vercel AI Gateway is the runtime.

## The model

- **Workspace** — a tenant. One company, one managed private GitHub repo, one set of members.
- **Agent** — a `.agent` file at `agents/<slug>.agent` in the workspace repo. Title, instructions, model, tools — one file, no separate config.
- **Mentions** — write `@exa` or `@deep` in the body. The editor parses mentions and rewrites the frontmatter, so the instructions stay the source of truth.
- **Sync** — every save commits to Postgres immediately and queues an asynchronous GitHub write. The editor never blocks on GitHub.
- **Runtime** — agents run through Vercel AI Gateway, which abstracts OpenAI, Anthropic, and other providers behind a single API.

The `.agent` file is the contract. Anything that touches an agent — the UI, the sync worker, the runtime — reads or writes that format. See [docs/agent-file.md](./docs/agent-file.md) for the full spec.

## Stack

Turborepo on Bun · Next.js (App Router) · Drizzle on Neon Postgres · WorkOS AuthKit · Inngest background jobs · Vercel AI Gateway · GitHub App for managed repos · Better Stack-compatible error capture · deployed on Vercel and Render.

The maintained technology register lives at [docs/stack/README.md](./docs/stack/README.md). It tracks what each major dependency or vendor does for us, why it is in the stack, who owns it, and what would make us replace it.

## Quick start

```bash
bun install
bun run setup
bun run dev
```

`bun run setup` is idempotent: it copies `.env.example`, pulls shared dev env vars from Infisical when linked, creates or reuses a Neon branch for the current Git branch, and runs migrations. See [docs/getting-started.md](./docs/getting-started.md) for the full walkthrough.

## Repo layout

- `apps/web` — the Next.js app
- `packages/db` — shared Drizzle schema and client
- `scripts` — setup, env-pull, and Neon branching automation
- `drizzle` — checked-in migrations
- `docs` — concept, format spec, and operational guides
- `.claude/skills` — agent skills (`start-work`, `pre-merge-check`)

## Quality gates

Every PR runs on GitHub Actions: `format:check`, `lint`, `typecheck`, `build`, `test`, and TruffleHog secret scanning. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full list and the local commands.

## Docs

- [The `.agent` file format](./docs/agent-file.md) — deep dive into the file that defines every agent
- [Getting started](./docs/getting-started.md) — local dev setup in under five minutes
- [Architecture](./docs/architecture.md) — runtime shape, sync, and database model
- [Technology stack](./docs/stack/README.md) — technology register, owners, and replacement triggers
- [Database](./docs/database.md) — Neon branching, schema changes, Drizzle
- [Deployment](./docs/deployment.md) — production release flow, Vercel, Render, env, smoke checks
- [Secret management](./docs/secret-management.md) — Infisical source of truth and sync setup
- [Environment variables](./docs/env-vars.md) — where every runtime and release env var lives
- [Auth](./docs/auth.md) — WorkOS AuthKit, env vars, identity model
- [Observability](./docs/observability.md) — production error capture and launch debugging
- [Contributing](./CONTRIBUTING.md)
