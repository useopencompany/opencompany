# Contributing

This repo is optimized for small, reviewable PRs from humans and coding agents.

## Local checks

Before opening a PR, run the same gates that CI runs:

```bash
bun run format:check   # biome
bun run lint           # eslint (next config)
bun run typecheck      # tsc --noEmit
bun run build          # next build
bun run test           # vitest, unit tests only
```

If `trufflehog` is installed locally (`brew install trufflehog`), also run `bun run secrets:check`. CI runs it on every PR regardless.

End-to-end tests live in `apps/web/e2e` and run against a local dev server. They are **not** in CI yet — there's no Postgres service wired up — so they are opt-in:

```bash
bun run --filter @opencompany/web test:e2e
```

## Tooling notes

- **Biome is the formatter; ESLint is the linter.** Biome handles formatting and import ordering only — its lint rules are off. ESLint stays on for Next-specific rules. Don't enable both without auditing rule overlap.
- **CI placeholder envs.** The workflow injects placeholder values for `DATABASE_URL` / `WORKOS_*` so `next build` can run without a real database. Production builds still need real secrets via Vercel.
- **Secret scanning.** TruffleHog runs on every PR (free, AGPL-3.0 — no license signup required, unlike gitleaks-action). It scans for verified and unknown secrets across the diff. Enable GitHub's native push protection too — it catches leaks before they hit CI.

## Labels

Use these when they clarify review risk:

- `schema` — Drizzle schema or migration changes
- `env` — environment variable or setup changes
- `auth` — WorkOS or session changes
- `ci` — workflow, test, or tooling changes
- `risk:high` — production data, auth, billing, or broad user flows

## Conventions

- Add a Drizzle migration for any change to `packages/db/src/schema.ts`.
- Update `.env.example` and the relevant doc when adding an env var.
- Prefer unit-testable pure modules (see `apps/web/lib/onboarding/validation.ts`) over deeply mocked server-action tests.
