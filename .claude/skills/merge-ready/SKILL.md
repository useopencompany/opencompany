---
name: merge-ready
description: Use when deciding whether a branch or PR is actually ready to merge — before merging, before flipping a draft to ready, or when the user says "merge ready", "ready to merge", "ship check", "can this go out", "is this PR done". For a quick static-only audit use pre-merge-check instead.
---

# merge-ready

The full go/no-go gate before code ships: static audit + risk-targeted deep checks + adversarial
review + real QA + live CI/CodeRabbit/merge status → one verdict. It **composes** the narrower
skills instead of repeating them.

**Two hard rules, always:** read-only audit (surface a punch list, don't auto-fix unless asked),
and **the merge button is the human's** — never `gh pr merge`, never `gh pr ready`.

## Core principle

Catch each bug class at the layer that can see it, and scale depth to the diff's risk. Green CI is
necessary but NOT sufficient — it doesn't run migrations against a real DB, doesn't do real QA, and
doesn't catch logic bugs. Trivial diffs stay fast; risky diffs get every gate.

## Workflow

### 0. Scope the change
```bash
git status --short --branch
git diff --name-only origin/main...HEAD   # committed
git diff --name-only                      # modified
git ls-files --others --exclude-standard  # untracked
gh pr view --json number,isDraft,state,mergeable,reviewDecision 2>/dev/null
```
Union of committed+modified+untracked = the changed-file list. In a Conductor workspace, if
`origin/main...HEAD` is empty but local changes exist, say so clearly — the branch won't merge those
until committed+pushed (verdict becomes "GO after commit+push").

### 1. Static audit — REQUIRED SUB-SKILL: pre-merge-check
Run it for the CI-equivalent checks (install/format/lint/typecheck/build/test), schema↔migration,
env↔`.env.example`, docs, deps, secret scan. Don't repeat those here.

### 2. Classify diff risk → pull the matching deep gates
| Touched | Extra gate (this skill) |
|---|---|
| migrations / `drizzle/**` / `schema.ts` | §3 fresh-DB apply + destructive-op scan |
| auth / `proxy.ts` / public route / permissions | security review (use security-review skill) |
| Inngest / cron / background job / queue | idempotency + retry + a recovery path exist? |
| exported types / API routes / event payloads | §4 contract/caller check |
| Stripe / credits / money | idempotency keys + amount/rounding review |
| new external integration (Slack/Google/…) | env present in Infisical+Vercel/Render (`docs/env-vars.md` map) + **safe-degradation**: no-ops when unconfigured |
| user-facing UI/flow | §6 real QA is mandatory |

### 3. Fresh-DB migration apply (only if migrations changed)
**CI does not run migrations** — this is the #1 thing that breaks the prod release's `db:migrate`.
Apply to a throwaway DB and confirm it succeeds from clean (e.g. `bun run db:branch:create` for a
fresh Neon branch, then `bun run db:migrate`; or a scratch schema). Open the SQL; flag `DROP`,
`ALTER TYPE`, and `NOT NULL` without a default.

### 4. Contract / breaking change
If exported types, API routes, or event payloads changed: grep the callers and verify none broke (new
required field, changed shape/return, new exception). For an event payload, confirm **every dispatcher
and every consumer** agree.

### 5. Code review — REQUIRED SUB-SKILL: code-review (high or higher)
Run it. Treat CONFIRMED/PLAUSIBLE correctness findings as blockers — don't merge over unresolved
logic findings.

### 6. Real QA (dynamic) — REQUIRED SUB-SKILL: verify (or run)
Boot the app and actually exercise the **changed** user-facing flows (project QA convention: copy env,
dev server, click through; never carelessly against prod data). For a backend/data change, exercise the
real code path (script the function, inspect the row). Capture a screenshot/log as evidence. **QA red →
NO-GO.**

### 7. Live PR status (when a PR exists)
- `gh pr view --json state,isDraft,mergeable,reviewDecision` → `mergeable != CONFLICTING`,
  `reviewDecision != CHANGES_REQUESTED`.
- `gh pr checks` → all green (not pending/failing). A draft's green **CodeRabbit** is "skipped", not clean.
- `pr-watch <pr#> <owner/repo>` → surfaces all CodeRabbit hiding spots + CI rollup + conflicts (exit 10 = actionable).
- Author-filter gotcha: scan `gh pr list --state open` **without** `--author` (the PR may be opened under a different account).

### 8. Verdict
End with **GO** or **NO-GO**, grouped by risk class, each line citing the evidence (which check, what it
showed). Only local changes → "GO after commit+push". Never auto-flip ready, never merge — state plainly
that the merge button is the human's.

### 9. Post-merge watch (offer, after the human merges)
Watch the release pipeline (`gh run watch` — the prod `db:migrate` + deploy) and the Better Stack error
rate for ~10 min; alert if it goes red. Catches what static checks can't, fast. Use prod-debug for the
Better Stack / prod-DB lookups.

## Common mistakes
- **Green CI ⇒ mergeable** — it isn't: CI skips migrations, real QA, and logic bugs. Run §3/§5/§6.
- **Trusting a draft's CodeRabbit "pass"** — CR skips drafts; that green is fake.
- **Background-job change without a recovery path** — a stuck `pending`/`failed` row that never self-heals.
- **Shipping with the external/customer side unverified** — e.g. an invite the code "sent" that never arrived.
- **Firing all checks blindly** — route by §2; depth should match risk.

## Don't
- Never `gh pr merge` or `gh pr ready` — the human presses the button.
- Don't auto-fix; surface a punch list (unless the user explicitly says "fix it too").
- Don't run migrations/seeds against `main`'s or prod's DB — use a scratch/branch DB.
