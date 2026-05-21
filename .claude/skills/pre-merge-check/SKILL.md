---
name: pre-merge-check
description: Audit the current branch before merging a PR. Checks that schema changes have migrations, env changes are reflected in .env.example, workflow changes are documented in docs/, and lint passes. Use when the user says "ready to merge", "pre-merge check", "before I merge", or "PR check".
---

# Pre-merge check

Goal: catch the things humans forget right before merging — out-of-date docs, missing migrations, undeclared env vars, broken types. Surface findings as a punch list. Do not auto-fix unless the user asks.

## How to run

Work against `origin/main`. Use `git diff --name-only origin/main...HEAD` to get the list of changed files, then run checks based on what's in that list. Skip checks whose triggers don't fire.

Always run lint and the schema/migration check. Other checks are conditional.

## Checks

### 1. Lint (always)

Run `npm run lint` (which is `tsc --noEmit`). If it fails, report the errors.

### 2. Schema ↔ migration (always)

If `lib/db/schema.ts` changed:

- Verify a new file exists under `drizzle/` (compare `git diff --name-only origin/main...HEAD -- drizzle/`).
- If schema changed without a new migration file: flag it, tell the user to run `npm run db:generate`.
- If both changed: open the migration SQL and sanity-check it matches the schema delta. Look for destructive ops (DROP, ALTER TYPE) and call them out.

### 3. Env vars ↔ `.env.example`

If any of these grew a new `process.env.X` reference, check `.env.example` lists it (commented out is fine for optional CI vars):

- Anything under `lib/`, `app/`, `middleware.ts`, `scripts/`, `drizzle.config.ts`.

Use grep for `process\.env\.` in the diff to find new references. Flag any new env var missing from `.env.example`.

### 4. Setup/workflow changes ↔ `docs/`

Trigger one or more checks based on what changed:

| Files changed | Must check |
|---|---|
| `scripts/setup.mjs`, `scripts/neon-branch.mjs`, `package.json` scripts section | `docs/getting-started.md` mentions the new/changed flow |
| `lib/db/**`, `drizzle.config.ts`, `drizzle/**`, schema changes | `docs/database.md` reflects new tables / workflow |
| `lib/auth.ts`, `middleware.ts`, `app/auth/**`, `components/LoginPanel.tsx` | `docs/auth.md` is accurate |
| New top-level npm script | `docs/` mentions when to run it |
| `.env.example` changes | `docs/getting-started.md` or `docs/database.md` / `docs/auth.md` covers the new var |

For each trigger, open the relevant doc and verify the changed concept is described. If not, flag it with a one-line suggestion of what to add.

Don't be pedantic about wording — only flag genuinely missing or misleading content. A typo fix in code doesn't require a doc update.

### 5. Dependencies

If `package.json` changed:

- Verify `package-lock.json` was committed too.
- If a new runtime dep was added, briefly note what for in the PR summary suggestion.

### 6. WorkOS/Neon dashboard changes

If `middleware.ts` `unauthenticatedPaths` or `redirectUri` changed, or `NEXT_PUBLIC_WORKOS_REDIRECT_URI` semantics changed: remind the user to update the WorkOS dashboard allowlist in any environment that's affected (and note this in the PR description).

## Output format

Produce a punch list, grouped as:

- **Blockers** — lint failures, missing migrations, undeclared env vars used in code.
- **Should fix** — out-of-date docs, missing `.env.example` entries for optional vars.
- **FYI** — dashboard-config reminders, destructive migrations to call out in the PR description.

End with a one-line verdict: `Ready to merge` or `Address blockers first`.

## Don't

- Don't run `git push`, `gh pr merge`, or any other action that ships code. This skill is read-only audit + suggest.
- Don't rewrite docs unless the user explicitly says "fix the docs too". Surface gaps; let the human decide.
- Don't run the dev server or migrations against `main`'s Neon branch. The current branch's Neon DB is fine for lint/typecheck.
