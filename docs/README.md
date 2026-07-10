# Docs

- [getting-started.md](./getting-started.md) — new engineer checklist and fastest path to a running dev environment.
- [architecture.md](./architecture.md) — rough map of the app, agent editing, GitHub storage, and Inngest sync.
- [future-concepts/README.md](./future-concepts/README.md) — speculative product and architecture notes for ideas that are not active implementation contracts yet.
- [stack/README.md](./stack/README.md) — technology register: what we use, why, owners, and exit triggers.
- [database.md](./database.md) — Neon, schema changes, Drizzle, and optional branch databases.
- [auth.md](./auth.md) — WorkOS AuthKit flow, env vars, identity model.
- [analytics.md](./analytics.md) — PostHog analytics package, event registry, and privacy rules.
- [observability.md](./observability.md) — production error capture and launch debugging.
- [agent-mcp.md](./agent-mcp.md) — local SigNoz MCP setup for Conductor, Claude Code, and Codex.
- [signoz-goat-observability.md](./signoz-goat-observability.md) — SigNoz Goat dashboard, MCP investigation workflow, metrics, spans, and events.
- [changelog.md](./changelog.md) — how to update `CHANGELOG.md` from the true merge history, including screen recordings ([changelog-media.md](./changelog-media.md)).
- [../CONTRIBUTING.md](../CONTRIBUTING.md) — local checks, CI gates, conventions.

## Repo layout

- `apps/web` — the Next.js application.
- `apps/inngest-dev` — local Inngest dev-server wrapper used by `bun run dev`.
- `packages/db` — shared Drizzle schema and database client exports.
- `scripts` — repo-wide setup, env, and database automation.
- `drizzle` — checked-in database migrations.

## Quality gates

Every PR runs `format:check`, `lint`, `typecheck`, `build`, `test`, and TruffleHog secret scanning on GitHub Actions. End-to-end (Playwright) tests are local-only for now — see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Skills

Two [agent skills](https://agentskills.io) live in `.claude/skills/` and any skills-compatible agent on this repo will pick them up:

- `start-work` — bootstrap a fresh work session. Ask your agent to "start work" and it will branch, run setup, and confirm you're ready.
- `pre-merge-check` — audit the current branch before merging. Ask "run the pre-merge check" and it will lint, verify migrations match schema changes, and flag stale docs / missing env vars.
