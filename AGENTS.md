# Agent coding guidelines

You're working on opencompany: an AI workspace for chat, durable tasks and workflows,
connected integrations, Brain knowledge, and cloud coding sessions.

Read the nested `AGENTS.md` files when reading/editing files inside folders that contain it.

## North Star

We are building world-class software: high quality, high reliability, excellent UX, and code that a strong engineering team would be proud to review later.

Use judgment. The goal is not to follow rules mechanically; the goal is to ship correct, maintainable work with clear verification.

## Stack

- Package manager: `bun@1.3.2`
- Runtime: Node `>=20.20.0`
- Stack: Turborepo, Bun, Next.js App Router, Drizzle, Neon Postgres, WorkOS AuthKit, Vercel AI Gateway, GitHub App integration.
- Product app: `apps/web`
- Shared runner service: `apps/runner`
- Database package: `packages/db`

## Scripts

- Install dependencies: `bun install`
- Local setup: `bun run setup`
- Format check: `bun run format:check`
- Lint: `bun run lint`
- Typecheck: `bun run typecheck`
- Build: `bun run build`
- Unit tests: `bun run test`
- UI behavior: run `bun run dev:web` and verify the real route in a browser
- Secret scan when available: `bun run secrets:check`
- Use Turborebo filtering syntax to run commands against specific apps/packages: `bun run dev --filter @opencompany/web`

The user usually keeps a dev server running. Do not start another one unless asked or unless you have confirmed it is needed.

## opencompany product surface

- Start in `apps/web` for product and API work.
- `web` is the Next.js client and composition root. "opencompany runner" means the retained
  opencompany-domain execution paths inside `apps/runner`. Look first at Brain, task, and chat
  modules, `/internal/goat/*` routes, and the `RUNNER_OPENCOMPANY_TASK_WORKER_ENABLED` gate. There is no
  separate runner package.
- Follow shared code into `packages/db/src/*`, `packages/brain`, and
  `packages/telemetry` as needed. Preserve the isolated legacy-billing and LLM-broker
  compatibility schemas unless a task explicitly retires those contracts.
- Use `docs/system-map.md` for the current app/runner flow and `bun run dev:web` for the
  local product stack.

## Engineering Judgment

- Correctness beats speed. Code that types and tests pass is not automatically correct.
- Prefer existing local patterns, helpers, components, and conventions over new abstractions.
- Fix adjacent issues when they materially affect the task, correctness, or maintainability of touched code. Do not bundle unrelated cleanup into the same PR.
- Push back when a request would make the system worse. State the tradeoff and propose the better path.
- Keep names precise. A good name should remove the need for a comment.
- Delete dead code. Do not leave commented-out code or TODOs without a real tracking reason.
- Write descriptive comments where some patterns are not clear.
- DO NOT write unneccessary comments for obvious things, but make sure to comment complex logic or workarounds.
- Validate user input and external API responses at boundaries. Internal code should be typed enough to avoid defensive clutter.

## Reliability And Safety

- Do not swallow errors silently. Surface them, handle them, or make the invalid state impossible.
- Do not add retries, fallbacks, feature flags, or abstractions for hypothetical future problems.
- Treat external input as hostile.
- Never commit secrets, log secrets, or echo secret values in summaries.
- Avoid new dependencies unless the value clearly outweighs maintenance and security cost.

## Data And Env Changes

- Any change to `packages/db/src/schema.ts` needs a Drizzle migration.
- Migration or data-destructive work gets extra scrutiny. Explain rollback implications before running one-way operations.
- New env vars require `.env.example` and the relevant docs update.
- Production env vars must be added to the runtime-specific Infisical path and verified in the hosted service before release: the web app uses `prod` + `/web`, the runner uses `prod` + `/runner`, and release automation uses `prod` + `/release`. Add required variables to the matching release preflight so a missing sync fails the release instead of silently disabling behavior.
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
- `docs/future-concepts/README.md` - speculative product and architecture ideas that may inform future work
- `docs/getting-started.md` - local setup
- `docs/database.md` - Neon, Drizzle, and migrations
- `docs/deployment.md` - release flow
- `docs/env-vars.md` - environment variables

## Communication

- Be direct. State conclusions first, then the reasoning.
- Flag uncertainty and unverified work.
- Surface tradeoffs when there are multiple reasonable approaches.
- Keep final summaries short and specific: changed files, verification, and remaining risk.

## When In Doubt

Ask whether a great engineering team would approve the diff. If not, do the extra work or explain the blocker.

### Cloud coding sandboxes

This section applies only when the system prompt gives you a staged environment file for this repository:

1. Never inspect or print it. If `.env.local` is missing, copy the staged file there and set mode `600`.
2. Run `bun install --frozen-lockfile`, then `bun run setup`, before starting any development process.
3. Start `bun run dev:web` only after setup succeeds.

Cloud setup refreshes the schema-only `cloud-base` Neon branch and creates a sandbox-unique child branch from it. Do not override that parent or start the dev server against an unset `DATABASE_URL`.

Local dev logs: `bun run dev` and `bun run dev:stream` write Turbo task output to `.context/logs/dev-turbo.json`. Use `bun run dev:logs -- --source runner --tail 100`, `bun run dev:logs -- --source web --tail 100`, `bun run dev:logs -- --errors`, or `bun run dev:logs -- --grep <text>` when debugging. The log file is gitignored and may contain sensitive terminal output, so summarize relevant lines instead of pasting large raw excerpts.
