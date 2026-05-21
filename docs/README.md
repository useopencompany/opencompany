# Docs

- [getting-started.md](./getting-started.md) — first-time setup, fastest path to a running dev environment.
- [database.md](./database.md) — Neon branching workflow, schema changes, Drizzle.
- [auth.md](./auth.md) — WorkOS AuthKit flow, env vars, identity model.

## Repo layout

- `apps/web` — the Next.js application.
- `packages/db` — shared Drizzle schema and database client exports.
- `scripts` — repo-wide setup, env, and database automation.
- `drizzle` — checked-in database migrations.

## Skills

Two [agent skills](https://agentskills.io) live in `.claude/skills/` and any skills-compatible agent on this repo will pick them up:

- `start-work` — bootstrap a fresh work session. Ask your agent to "start work" and it will branch, run setup, and confirm you're ready.
- `pre-merge-check` — audit the current branch before merging. Ask "run the pre-merge check" and it will lint, verify migrations match schema changes, and flag stale docs / missing env vars.
