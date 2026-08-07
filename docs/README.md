# Docs

- [getting-started.md](./getting-started.md) — new engineer checklist and fastest path to a running dev environment.
- [architecture.md](./architecture.md) — the system map: headless core, surfaces, the durable execution model, and the frozen storage contracts.
- [database.md](./database.md) — Neon, schema changes, Drizzle, and branch databases.
- [runner.md](./runner.md) — the execution service: workers, internal routes, scaling.
- [deployment.md](./deployment.md) — production release flow, Vercel, Render, smoke checks.
- [env-vars.md](./env-vars.md) — where every runtime and release env var lives.
- [secret-management.md](./secret-management.md) — Infisical source of truth and sync setup.
- [auth.md](./auth.md) — WorkOS AuthKit flow, env vars, identity model.
- [analytics.md](./analytics.md) — PostHog analytics package, event registry, and privacy rules.
- [observability.md](./observability.md) — production error capture, telemetry, and debugging.
- [signoz-observability.md](./signoz-observability.md) — SigNoz dashboard, MCP investigation workflow, metrics, spans, and events.
- [agent-mcp.md](./agent-mcp.md) — local SigNoz MCP setup for Conductor, Claude Code, and Codex.
- [chat-sandbox.md](./chat-sandbox.md) — the persistent browser sandbox for main chat.
- [github-local-dev.md](./github-local-dev.md) — testing the GitHub work integration locally.
- [feedback-intake.md](./feedback-intake.md) — in-app feedback to Linear triage.
- [changelog.md](./changelog.md) — how to update `CHANGELOG.md` from the true merge history, including screen recordings ([changelog-media.md](./changelog-media.md)).
- [stack/README.md](./stack/README.md) — technology register: what we use, why, owners, and exit triggers.
- [future-concepts/README.md](./future-concepts/README.md) — speculative product and architecture notes that are not active implementation contracts.
- [../CONTRIBUTING.md](../CONTRIBUTING.md) — local checks, CI gates, conventions.

The app-level system map — the detailed chat/task/workflow/coding-engine flow across `apps/app`
and `apps/runner` — lives at [apps/app/docs/README.md](../apps/app/docs/README.md).

## Repo layout

- `apps/app` — the Next.js product application (my.opencompany.chat).
- `apps/runner` — the long-lived Fastify execution service.
- `apps/macos` — opencompany Quick, the macOS menu-bar composer.
- `apps/marketing`, `apps/design-system`, `apps/stripe-webhooks` — marketing site, UI showcase, local Stripe webhook shell.
- `packages/core`, `packages/brain`, `packages/db`, `packages/agent-runtime`, `packages/telemetry`, `packages/observability`, `packages/analytics`, `packages/billing`, `packages/ui`, and friends — the shared product engine and libraries.
- `scripts` — repo-wide setup, env, database, and release automation.
- `drizzle` — checked-in database migrations (append-only; never edit existing files).

## Quality gates

Every PR runs `format:check`, `lint`, `typecheck`, `build`, `test`, and TruffleHog secret scanning on GitHub Actions. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Skills

Agent skills live in `.claude/skills/` and any skills-compatible agent on this repo will pick them up:

- `start-work` — bootstrap a fresh work session: branch sanity, deps, env, migrations.
- `pre-merge-check` — audit the current branch before merging: checks, migrations, env docs.
- `prod-debug` — read-only production debugging through Infisical and Better Stack.
- `cto-review` — deep repo-wide review against a world-class bar.
- `vercel-react-best-practices` — React/Next.js performance guidance from Vercel Engineering.
