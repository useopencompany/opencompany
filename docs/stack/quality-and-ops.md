# Quality and Operations

## Infisical

**What it is:** Secrets management platform.

**What it does for us:** Source of truth for runtime and release secrets. Vercel, Render, and
GitHub Actions are delivery targets.

**Where it is used:**

- Root `package.json` `infisical:*` scripts.
- `scripts/infisical-export-local.mjs`.
- `.github/workflows/release-production.yml`.
- `docs/secret-management.md`.

**Why we use it:** It centralizes secret ownership, sync, and release-time secret access instead of
hand-editing values independently across Vercel, Render, local env files, and GitHub.

**Owner:** Platform / Security.

**Reconsider if:** Secret sync reliability becomes a release risk, access control does not match our
org model, or we need a different compliance/security posture.

## GitHub Actions

**What it is:** CI/CD runner platform.

**What it does for us:** Runs PR/main checks and serializes production releases after CI succeeds.

**Where it is used:**

- `.github/workflows/ci.yml`.
- `.github/workflows/release-production.yml`.

**Why we use it:** It is close to the repo, integrates with protected branches/environments, and can
coordinate Vercel, Render, Neon, and Infisical without introducing another release system.

**Owner:** Platform.

**Reconsider if:** Release orchestration needs outgrow YAML workflows, job duration/capacity becomes
a bottleneck, or deployment controls need a dedicated CD platform.

## TruffleHog

**What it is:** Secret scanner.

**What it does for us:** Scans PRs/main history in CI for verified and unknown secrets.

**Where it is used:**

- `.github/workflows/ci.yml`.
- Root `package.json` `secrets:check`.

**Why we use it:** Secret leakage is a high-impact failure mode, and a repo-level scanner is a cheap
guardrail.

**Owner:** Security.

**Reconsider if:** We standardize on another scanner through GitHub Advanced Security or a broader
security platform.

## Quality toolchain

**What it is:** The baseline engineering checks for the repo.

**What it does for us:** Keeps code review focused on product and architecture by making formatting,
linting, type checking, and tests explicit gates.

**Current tools:**

| Tool | Role |
|---|---|
| TypeScript | Static contracts across web, runner, packages, and scripts. |
| Biome | Repo-wide formatting. |
| ESLint | Framework/package lint checks where Biome is not enough. |
| Vitest | Unit and integration-style tests. |
| Playwright | Local end-to-end smoke tests. |

**Where it is used:**

- Root `package.json` scripts: `format:check`, `lint`, `typecheck`, `build`, `test`.
- `.github/workflows/ci.yml`.
- `CONTRIBUTING.md`.

**Why we use it:** This is not meant to be a list of strategic vendors. It is the minimum toolchain
that keeps a TypeScript monorepo reliable enough to ship.

**Owner:** Platform.

**Reconsider if:** CI becomes slow or noisy, checks diverge across packages, or a smaller toolchain
can enforce the same standards with less maintenance.

## Better Stack and Sentry SDKs

**What it is:** Better Stack receives errors through Sentry-compatible DSNs; Sentry SDKs provide the
client/server capture transport.

**What it does for us:** Captures production errors from the Next.js app and the Bun runner through
the repo-owned `@opencompany/observability` facade.

**Where it is used:**

- `packages/observability`.
- `apps/web/instrumentation.ts`.
- `apps/web/instrumentation-client.ts`.
- `apps/runner/src/index.ts`.
- `BETTER_STACK_ERRORS_DSN`, `NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN`,
  `OBSERVABILITY_*`, `NEXT_PUBLIC_OBSERVABILITY_*` in `.env.example`.
- `docs/observability.md`.

**Status:** Optional. Missing DSNs disable remote error capture safely.

**Why we use it:** We need production error visibility for web, auth, GitHub sync, runner, sandbox,
and hosted-tool failures without committing to a full tracing/logging platform yet.

**Owner:** Platform.

**Reconsider if:** We need first-class distributed traces, structured log ingestion, alerting,
session replay, or AI-specific tracing that Better Stack/Sentry-compatible capture does not cover.
