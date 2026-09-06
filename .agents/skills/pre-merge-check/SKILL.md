---
name: pre-merge-check
description: Audit the current branch before merging a PR. Checks committed and local workspace changes, schema migrations, env docs, workflow docs, CI-equivalent checks, and CI secret scan results. Use when the user says "ready to merge", "pre-merge check", "before I merge", or "PR check".
---

# Pre-merge check

Goal: catch the things humans forget right before merging — out-of-date docs, missing migrations, undeclared env vars, broken types. Surface findings as a punch list. Do not auto-fix unless the user asks.

## How to run

Work against `origin/main`, but account for Conductor workspaces where the PR content may still be local/uncommitted.

Start with:

```bash
git status --short --branch
git diff --name-only origin/main...HEAD
git diff --name-only
git ls-files --others --exclude-standard
```

Use the union of committed, modified, and untracked files as the changed-file list. If `origin/main...HEAD` is empty but local changes exist, call that out clearly: the branch will not merge those changes until they are committed and pushed.

Always run the CI-equivalent checks and the schema/migration check. Other checks are conditional.

## Checks

### 1. CI-equivalent checks (always)

Run:

```bash
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run build
bun run test
```

Verify the secret scan in GitHub Actions for the current branch's PR:

```bash
gh pr view --json headRefOid,statusCheckRollup,url
```

Require `Verify pull request / Secret scan` to have completed with `SUCCESS` for the current PR head. Use the linked Actions run to inspect a failure. CI runs TruffleHog; no local installation or scan is required.

If the scan is missing, pending, skipped, cancelled, failing, or inaccessible, report secret scanning as unverified or failed and withhold `Ready to merge`. If there is no PR or there are unpushed commits or local changes, report that those changes need a successful CI scan after commit/push. A passing scan on an earlier head does not cover them.

If any command fails, report the failing command and the relevant error. If Turbo reports cached results, that is acceptable for a quick pre-merge pass, but prefer direct package commands when debugging a failure.

### 2. Schema ↔ migration (always)

If `packages/db/src/schema.ts` changed in committed or local files:

- Verify a new file exists under `drizzle/` (check both `git diff --name-only origin/main...HEAD -- drizzle/` and local/untracked drizzle files).
- If schema changed without a new migration file: inspect the schema diff. If only file location/import/package wiring changed and table/index/relation definitions are identical, report it as FYI. Otherwise flag it and tell the user to run `bun run db:generate`.
- If both changed: open the migration SQL and sanity-check it matches the schema delta. Look for destructive ops (DROP, ALTER TYPE) and call them out.

### 3. Env vars ↔ `.env.example`

If any of these grew a new `process.env.X` reference, check `.env.example` lists it (commented out is fine for optional CI vars):

- Anything under `apps/web/lib/`, `apps/web/app/`, `apps/web/proxy.ts`, `scripts/`, `packages/db/`.

Use grep for `process\.env\.` in the committed and local diffs to find new references. Flag any new env var missing from `.env.example`.

### 4. Setup/workflow changes ↔ `docs/`

Trigger one or more checks based on what changed:

| Files changed | Must check |
|---|---|
| `scripts/setup.mjs`, `scripts/neon-branch.mjs`, `package.json` scripts section | `docs/getting-started.md` mentions the new/changed flow |
| `packages/db/**`, `drizzle/**`, schema changes | `docs/database.md` reflects new tables / workflow |
| `apps/web/lib/auth.ts`, `apps/web/proxy.ts`, `apps/web/app/auth/**`, auth UI components | `docs/auth.md` is accurate |
| New top-level package script | `docs/` mentions when to run it |
| `.env.example` changes | `docs/getting-started.md` or `docs/database.md` / `docs/auth.md` covers the new var |

For each trigger, open the relevant doc and verify the changed concept is described. If not, flag it with a one-line suggestion of what to add.

Don't be pedantic about wording — only flag genuinely missing or misleading content. A typo fix in code doesn't require a doc update.

### 5. Dependencies

If `package.json` changed:

- Verify `bun.lock` was committed too and `package-lock.json` was not reintroduced.
- If a new runtime dep was added, briefly note what for in the PR summary suggestion.
If the lockfile changes locally, run `bun install --frozen-lockfile` to verify it is consistent.

### 6. WorkOS/Neon dashboard changes

If `apps/web/proxy.ts` `unauthenticatedPaths` or `redirectUri` changed, or `NEXT_PUBLIC_WORKOS_REDIRECT_URI` semantics changed: remind the user to update the WorkOS dashboard allowlist in any environment that's affected (and note this in the PR description).

## Output format

Produce a punch list, grouped as:

- **Blockers** — lint failures, missing migrations, undeclared env vars used in code.
- **Should fix** — out-of-date docs, missing `.env.example` entries for optional vars.
- **FYI** — dashboard-config reminders, destructive migrations to call out in the PR description.

End with a one-line verdict: `Ready to merge` or `Address blockers first`. If local checks pass but CI secret scanning remains unverified, use `Awaiting CI secret scan`. If changes still need publishing, use `Ready for commit/push, then CI verification`.

## Don't

- Don't run `git push`, `gh pr merge`, or any other action that ships code. This skill is read-only audit + suggest.
- Don't rewrite docs unless the user explicitly says "fix the docs too". Surface gaps; let the human decide.
- Don't run the dev server or migrations against `main`'s Neon branch. The current branch's Neon DB is fine for lint/typecheck.
