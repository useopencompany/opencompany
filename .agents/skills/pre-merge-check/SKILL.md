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
git diff --cached --name-only
git ls-files --others --exclude-standard
```

Use the union of committed, modified, and untracked files as the changed-file list. If `origin/main...HEAD` is empty but local changes exist, call that out clearly: the branch will not merge those changes until they are committed and pushed.

Always run the CI-equivalent checks and the schema/migration check. Other checks are conditional.

## Checks

### 1. CI-equivalent checks (always)

Run the commands in [CONTRIBUTING.md](../../../CONTRIBUTING.md#local-checks), using
[verify.yml](../../../.github/workflows/verify.yml) as the CI source of truth. `bun run test`
uses Node-backed Vitest workers with CI concurrency limits. For fixture failures, consult
[database test fixtures](../../../docs/database.md#test-fixtures). Mobile has no automated tests;
follow its nested guidance. A local TruffleHog installation is optional for this audit; require the
hosted secret scan below.

Verify the secret scan in GitHub Actions for the current branch's PR. Query the commit check runs
through the REST API so this also works with GitHub App tokens that cannot read every status-rollup
context:

```bash
head=$(gh pr view --json headRefOid --jq .headRefOid)
gh api -H "Accept: application/vnd.github+json" \
  "repos/{owner}/{repo}/commits/$head/check-runs" \
  --jq '.check_runs[] | select(.name == "Verify pull request / Secret scan") | {head_sha, status, conclusion, html_url}'
```

Require `Verify pull request / Secret scan` to have completed with `success` for the current PR head. Use the returned Actions URL to inspect a failure. CI runs TruffleHog; no local installation or scan is required.

If the scan is missing, pending, skipped, cancelled, failing, or inaccessible, report secret scanning as unverified or failed and withhold `Ready to merge`. If there is no PR or there are unpushed commits or local changes, report that those changes need a successful CI scan after commit/push. A passing scan on an earlier head does not cover them.

If any command fails, report the failing command and the relevant error. If Turbo reports cached results, that is acceptable for a quick pre-merge pass, but prefer direct package commands when debugging a failure.

### 2. Schema ↔ migration (always)

Inspect every schema in [database docs](../../../docs/database.md#schema-modules), including
`product-schema.ts`, `legacy-billing-schema.ts`, `llm-broker-schema.ts`, and retained `schema.ts`.
Check generation inputs in `packages/db/drizzle.config.ts`. The CI coupling script only compares
committed revisions, so also inspect staged, unstaged, and untracked changes.

For each physical schema change:

- Verify a new file exists under `drizzle/` (check both `git diff --name-only origin/main...HEAD -- drizzle/` and local/untracked drizzle files).
- If schema changed without a new migration file: inspect the schema diff. If only file location/import/package wiring changed and table/index/relation definitions are identical, report it as FYI. Otherwise flag it and tell the user to run `bun run db:generate`.
- If both changed: open the migration SQL and sanity-check it matches the schema delta. Look for destructive ops (DROP, ALTER TYPE) and call them out.

### 3. Env vars ↔ `.env.example`

Inspect new env reads across `apps/api/src`, `apps/runner/src`, `apps/web`, shared packages,
and `scripts`, including config wrappers and `process.env` bracket/destructuring access.
Every added variable needs `.env.example` and the relevant entry in
[env docs](../../../docs/env-vars.md).

Use that doc's ownership table: prod `/api` owns API database/auth/provider ingress values,
`/runner` owns execution credentials, `/web` owns browser auth and thin relays, and `/release`
owns release automation. Local setup pulls shared API inputs from dev `/web`; do not infer prod
ownership from local paths. Check required values in `scripts/release-preflight.mjs` and require
hosted-service verification before release. Report missing or unverified configuration without
printing values.

### 4. Setup/workflow changes ↔ `docs/`

Trigger one or more checks based on what changed:

| Files changed | Must check |
|---|---|
| `scripts/setup.mjs`, `scripts/neon-branch.mjs`, `package.json` scripts section | `docs/getting-started.md` mentions the new/changed flow |
| `packages/db/**`, `drizzle/**`, schema changes | `docs/database.md` reflects new tables / workflow |
| `apps/api/src/auth.ts`, `apps/api/src/browser-origins.ts`, `apps/web/lib/auth.ts`, `apps/web/proxy.ts`, `apps/web/app/auth/**`, auth UI components | `docs/auth.md` is accurate |
| New top-level package script | `docs/` mentions when to run it |
| Env reads, `.env.example`, or release preflight changes | `docs/env-vars.md` records ownership and setup/release requirements |
| Company plugin connection, ingress, trigger, or worker changes | `docs/plugin-events.md` implementation checklist covers the changed path |

For each trigger, open the relevant doc and verify the changed concept is described. If not, flag it with a one-line suggestion of what to add.

Don't be pedantic about wording — only flag genuinely missing or misleading content. A typo fix in code doesn't require a doc update.

### 5. Dependencies

If `package.json` changed:

- If dependency declarations changed, verify `bun.lock` matches them. Script-only edits need no lockfile diff. Ensure `package-lock.json` was not reintroduced.
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

## Audit boundaries

- Don't run `git push`, `gh pr merge`, or any other action that ships code. This skill is read-only audit + suggest.
- Report documentation gaps; edit only when the user has requested fixes.
- Don't run the dev server or migrations against `main`'s Neon branch. The current branch's Neon DB is fine for lint/typecheck.
