# Contributing

This repo is optimized for small, reviewable PRs from humans and coding agents.

Before opening a PR, run:

```bash
bun run lint
bun run typecheck
bun run build
bun run test
bun run format:check
```

Use these labels when they clarify review risk:

- `schema` for Drizzle schema or migration changes.
- `env` for environment variable or setup changes.
- `auth` for WorkOS/session changes.
- `ci` for workflow, test, or tooling changes.
- `risk:high` for changes that affect production data, auth, billing, or broad user flows.

If you add an env var, update `.env.example` and the relevant docs. If you change `packages/db/src/schema.ts`, commit the generated migration under `drizzle/`.

Enable GitHub secret scanning and push protection for the repository or organization. CI also runs Gitleaks, but push protection catches leaked credentials earlier.
