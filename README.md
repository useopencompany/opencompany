# opencompany

A Next.js application for running and coordinating AI agents inside a company. Turborepo monorepo on Bun, Drizzle on Neon Postgres, WorkOS AuthKit for auth, deployed on Vercel.

## Quick start

```bash
bun install
bun run setup
bun run dev
```

`bun run setup` is interactive and idempotent — it copies `.env.example`, offers to pull shared dev env vars from Vercel, runs migrations, and optionally seeds. See [docs/getting-started.md](./docs/getting-started.md) for the full walkthrough.

## Repo layout

- `apps/web` — the Next.js app
- `packages/db` — shared Drizzle schema and client
- `scripts` — setup, env-pull, and Neon branching automation
- `drizzle` — checked-in migrations
- `docs` — getting-started, database, and auth guides
- `.claude/skills` — agent skills (`start-work`, `pre-merge-check`)

## Quality gates

Every PR runs on GitHub Actions: `format:check`, `lint`, `typecheck`, `build`, `test`, and `gitleaks`. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full list and the local commands.

## Docs

- [Getting started](./docs/getting-started.md)
- [Database](./docs/database.md) — Neon branching, schema changes, Drizzle
- [Auth](./docs/auth.md) — WorkOS AuthKit, env vars, identity model
- [Contributing](./CONTRIBUTING.md)
