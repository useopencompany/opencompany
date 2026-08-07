# AGENTS.md

How to work in this repo. Read this before you touch code.

## North Star

We are building world-class software: high quality, high reliability, excellent UX, and code that a strong engineering team would be proud to review later.

Use judgment. The goal is not to follow rules mechanically; the goal is to ship correct, maintainable work with clear verification.

## Repo Facts

- Package manager: `bun@1.3.2`
- Runtime: Node `>=20.20.0`
- Stack: Turborepo, Bun, Next.js App Router, Drizzle, Neon Postgres, ElectricSQL, WorkOS AuthKit, Vercel AI Gateway, E2B sandboxes, Stripe.
- Product app: `apps/app` (`@opencompany/app`), served at my.opencompany.chat
- Execution service: `apps/runner` (`@opencompany/runner`, Fastify on Render)
- Product engine: `packages/core`; knowledge domain: `packages/brain`
- Shared contracts: `packages/agent-runtime`; database: `packages/db`
- Telemetry (OTel): `packages/telemetry`; logs/error capture: `packages/observability`
- Other surfaces: `apps/macos` (opencompany Quick), `apps/marketing`, `apps/design-system`
- System map: `docs/architecture.md` (repo-wide) and `apps/app/docs/README.md` (app + runner flow)

Useful commands:

- Install dependencies: `bun install`
- Local setup: `bun run setup`
- Dev stack (app + runner): `bun run dev` (`bun run dev:tui` for Turbo's interactive TUI)
- Format check: `bun run format:check`
- Lint: `bun run lint`
- Typecheck: `bun run typecheck`
- Build: `bun run build`
- Unit tests: `bun run test`
- Managed-capabilities contract check: `bun run capabilities:contract`
- Secret scan when available: `bun run secrets:check`

The user usually keeps a dev server running. Do not start another one unless asked or unless you have confirmed it is needed.

### Cloud coding sandboxes

When the system prompt gives you a staged environment file for this repository:

1. Never inspect or print it. If `.env.local` is missing, copy the staged file there and set mode `600`. Setup mirrors app-local values into `apps/app/.env.local`; let `bun run setup` own that file.
2. Run `bun install --frozen-lockfile`, then `bun run setup`, before starting any development process.
3. Start `bun run dev` only after setup succeeds.

Cloud setup refreshes the schema-only `cloud-base` Neon branch and creates a sandbox-unique child branch from it. Do not override that parent or start the dev server against an unset `DATABASE_URL`.

Local dev logs: `bun run dev` writes Turbo task output to `.context/logs/dev-turbo.json`. Use `bun run dev:logs -- --source runner --tail 100`, `bun run dev:logs -- --source app --tail 100`, `bun run dev:logs -- --errors`, or `bun run dev:logs -- --grep <text>` when debugging. The log file is gitignored and may contain sensitive terminal output, so summarize relevant lines instead of pasting large raw excerpts.

## Product Context

opencompany is the platform for running a company with AI: chat backed by the workspace Brain, background tasks and workflows, and persistent cloud coding agents. The product contract is the chat/Brain/task/workflow platform described in `docs/architecture.md` — routes and server actions in `apps/app` stay thin and call into `packages/core`; all background execution flows through the durable turn queue that `apps/runner` drains for the three engines (`opencompany`, `codex`, `claude_code`).

A set of storage-level names is deliberately frozen from before the product rename — the Postgres schema `goat`, Electric wire names `goat.*`, E2B sandbox paths `/home/user/opencompany-goat/*`, stored event schema versions, row-id prefixes, and the `opencompany-goat*` telemetry service names. They are contracts baked into production data, live sandboxes, and external dashboards. Never rename them in passing; the full list and rationale live in `docs/architecture.md` under "Storage contracts".

## Work Loop

1. Read the surrounding code and relevant docs before writing.
2. For non-trivial changes, form a short plan and identify the real contract being changed.
3. Make the narrowest correct change that fits existing patterns.
4. Verify with the lightest command or browser check that proves the behavior.
5. Read the diff as if reviewing someone else’s PR.
6. Report what changed, what was verified, and what could not be verified.

## Engineering Judgment

- Correctness beats speed. Code that types and tests pass is not automatically correct.
- Prefer existing local patterns, helpers, components, and conventions over new abstractions.
- Fix adjacent issues when they materially affect the task, correctness, or maintainability of touched code. Do not bundle unrelated cleanup into the same PR.
- Push back when a request would make the system worse. State the tradeoff and propose the better path.
- Keep names precise. A good name should remove the need for a comment.
- Delete dead code. Do not leave commented-out code or TODOs without a real tracking reason.
- Comments should explain why something is surprising, not narrate what the code already says.
- Validate user input and external API responses at boundaries. Internal code should be typed enough to avoid defensive clutter.

## Reliability And Safety

- Do not swallow errors silently. Surface them, handle them, or make the invalid state impossible.
- Do not add retries, fallbacks, feature flags, or abstractions for hypothetical future problems.
- Treat external input as hostile.
- Never commit secrets, log secrets, or echo secret values in summaries.
- Avoid new dependencies unless the value clearly outweighs maintenance and security cost.

## Data And Env Changes

- Any change to the schema files in `packages/db/src` needs a Drizzle migration. Never edit or rename existing files under `drizzle/`.
- Migration or data-destructive work gets extra scrutiny. Explain rollback implications before running one-way operations.
- New env vars require `.env.example` and the relevant docs update (`docs/env-vars.md`).
- Production env vars must be added to the runtime-specific Infisical path and verified in the hosted service before release: the app uses `prod` + `/goat` (the folder name is a frozen external contract), the runner uses `prod` + `/runner`, and release automation uses `prod` + `/release`. Add required variables to `scripts/release-preflight.mjs` so a missing sync fails the release instead of silently disabling behavior.
- Local setup should use branch-isolated Neon DBs through `bun run setup`. Avoid shared database mode unless explicitly needed.
- Do not run production migrations or production-affecting scripts unless the user explicitly asks.

## Testing Expectations

Use the repo’s existing tooling. Do not introduce a new test runner or fixture style unless the existing setup cannot cover the behavior.

- Pure logic or utilities: add or update focused unit tests.
- API routes, server actions, and data flows: exercise the real path when practical.
- UI changes: verify in the browser against the running dev server, covering the main path and at least one obvious edge case.
- Refactors with intended no behavior change: run the existing relevant checks. Add a small characterization test if the touched behavior has no useful coverage.

If something cannot be verified because of missing env, unavailable services, or absent fixtures, say exactly what blocked verification.

## UX Expectations

- Use the existing design system and primitives. Do not hand-roll buttons, modals, spacing scales, or form patterns when local equivalents exist.
- Follow Next.js App Router idioms: Server Components by default, Client Components only for interactivity, Server Actions for mutations, and route-level loading/error boundaries where appropriate.
- Loading, empty, error, and slow states are part of the feature.
- Copy should be clear and human. Button labels and error messages matter.
- For user-facing changes, terminal checks are not enough; click through the behavior when possible.

## Docs

Keep docs honest, lightly. Update docs when behavior, setup, env vars, scripts, contracts, or external dependencies change. Internal refactors usually do not need doc changes unless they invalidate existing guidance.

Useful docs:

- `README.md` - project overview
- `CONTRIBUTING.md` - local checks and PR conventions
- `docs/architecture.md` - system map and the frozen storage contracts
- `apps/app/docs/README.md` - the detailed app + runner flow map
- `docs/getting-started.md` - local setup
- `docs/database.md` - Neon, Drizzle, and migrations
- `docs/deployment.md` - release flow
- `docs/env-vars.md` - environment variables
- `docs/future-concepts/README.md` - speculative product and architecture ideas that may inform future work

## Communication

- Be direct. State conclusions first, then the reasoning.
- Flag uncertainty and unverified work.
- Surface tradeoffs when there are multiple reasonable approaches.
- Keep final summaries short and specific: changed files, verification, and remaining risk.

## When In Doubt

Ask whether a great engineering team would approve the diff. If not, do the extra work or explain the blocker.
