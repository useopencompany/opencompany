# Contributing

opencompany is maintainer-led and under active development. Focused contributions to documentation,
tests, user experience, integrations, and well-scoped bugs are welcome. Read
[SUPPORT.md](./SUPPORT.md), [SECURITY.md](./SECURITY.md), and
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) before contributing.

## Start With an Issue

Use the bug form for reproducible defects and the proposal form for changes in behavior or scope.
Get maintainer design approval before implementing changes to architecture, database schema,
authentication, billing, deployment, or broad cross-cutting refactors. An approved direction is not
a promise that every implementation will merge; maintainability, compatibility, and verification
still matter.

Keep pull requests focused. Explain the problem, the chosen boundary, user-visible behavior, tests,
and anything reviewers cannot verify locally. UI changes need a browser check of the real route,
including the primary flow and an obvious error or empty state.

## Local Checks

Use Bun `1.3.2` and Node `20.20.0` or newer. Install exactly the committed dependency graph:

```bash
bun install --frozen-lockfile
```

Run the CI-equivalent gates before opening a pull request:

```bash
node scripts/check-schema-migration.mjs
bun run db:migrations:check
bun run format:check
bun run boundary:check
bun --bun turbo run lint
bun run typecheck
bun --filter @opencompany/protocol openapi:check
bun run build
bun run build:docs
bun run test
node --test scripts/lib/*.test.mjs
bun run secrets:check
```

TruffleHog must be installed for the local secret scan. The pull request gate scans the exact PR
commit range without repository credentials and reviews new high- or critical-severity dependency
vulnerabilities. `boundary:check` enforces the permanent application and naming boundaries. For
focused development, use Turborepo filters such as `bun run test --filter @opencompany/web`, but run
the full gate before review.

## Schema and Environment Changes

- A change to a database schema file needs a reviewed Drizzle migration unless it is strictly a
  TypeScript-only change with no database effect.
- Never rewrite migration history or run production migrations from a development task.
- New environment variables require `.env.example`, relevant setup and operations documentation,
  the correct hosted secret path, and release preflight coverage.
- Never commit secrets, provider bindings, private URLs, customer data, or generated workspace state.

## Tooling and Review

Biome owns formatting and import ordering. ESLint owns lint rules. Tests use Vitest. Prefer existing
components, helpers, and fixture styles over new abstractions.

External pull requests require the `PR gate`, CodeQL, and resolved review conversations. Reviews are
encouraged but are not a merge requirement. The main rules apply to administrators; do not bypass
them. Mandatory critical-path CODEOWNER approval remains deferred until a second active
maintainer is assigned.
