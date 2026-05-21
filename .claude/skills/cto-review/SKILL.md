---
name: cto-review
description: Deep, opinionated CTO-level review of the repo against a "world-class, open-source-ready" bar. Audits developer experience, OSS-release safety, code quality, architecture, security, docs, and tooling — then returns a prioritized punch list with rationale, not a wall of nits. Use when the user says "cto review", "deep review", "ship review", "world class check", "OSS readiness", "is this ready to open source".
---

# CTO review

This is **not** `pre-merge-check`. That skill looks at a diff and catches forgetting-things. This skill looks at the **whole repo** and asks the questions a CTO would ask before betting their reputation on shipping it as a public, world-class starter:

- Would a smart developer go from `git clone` to a running app in under 10 minutes without frustration?
- Is anything here unsafe, embarrassing, or proprietary if we make the repo public tomorrow?
- Where is the code, structure, or DX one notch below the bar — and is the fix worth doing?
- What's missing that every credible OSS project has?

Your job is to be opinionated, prioritize ruthlessly, and surface 5–15 high-leverage findings — not 50 nits.

## Mindset

A CTO review is **strategic**, not stylistic.

- **Question whether a thing should exist**, not just whether it's correct.
- **Weigh impact × effort.** A 10-minute fix that saves every contributor 20 minutes of confusion is gold; a week-long refactor that nobody benefits from is noise.
- **Default to terseness in findings.** One paragraph per item, with a concrete suggested action — not an essay.
- **Be honest about tradeoffs.** "We chose X over Y because Z" is a valid finding when Z is no longer true.
- **Do not nitpick style or naming** unless it's actively misleading or inconsistent in a way that confuses readers.
- **Do not invent problems** to look thorough. If a category is clean, say so in one line and move on.

## Scope of the audit

Read the **current state** of the repo, not the diff. Use `git ls-files` to enumerate tracked files. Read whole files for anything in `app/`, `lib/`, `components/`, `scripts/`, `middleware.ts`, `drizzle.config.ts`, `package.json`, `tsconfig.json`, `next.config.mjs`, `LICENSE`, `README.md` if present, and every file under `docs/`.

Skim, don't deep-read, the `drizzle/` migrations and any generated/lockfile content.

You may delegate broad searches to the `Explore` agent for things like "find every `process.env.` reference" or "find every `any` type", but do the synthesis yourself.

## Categories to evaluate

Work through each. For each category, decide: **clean / minor / needs work / blocker**. Only the latter two produce findings.

### 1. First-run developer experience

The single most important thing for a public starter. Imagine a developer who has never seen the repo.

- Does `README.md` exist at the root and explain what this is, why it exists, and how to run it in under 60 seconds of reading?
- Is the path from `git clone` → running app obvious and short? Are there silent failure modes? Does `bun run setup` produce good errors?
- Are required external accounts (WorkOS, Neon) called out before the user hits a prompt?
- Are script names consistent and self-explanatory (`db:branch:create`, `db:migrate`, `setup`)?
- Are there orphan or vestigial scripts/files (`load-env.mjs`, leftover `package-lock.json` references, dead `seed.mjs` rows)?

### 2. Open-source release safety

Treat this as a **gate**. Findings here are blockers until resolved.

- **LICENSE**: present, well-known (MIT/Apache-2.0/etc.), copyright line not pointing to a personal email or internal company name unless intended.
- **Secrets**: no real keys, tokens, project IDs, internal URLs, or personal identifiers in any tracked file. Grep `.env.example`, `conductor.json`, `vercel.json`, `scripts/`, any `.md`, and `lib/` for things that look like API keys, JWTs, or `sk_`/`pk_` prefixes. Note: `.env.local` and `.neon` should be gitignored; verify.
- **Personal/internal references**: search for the author's email, internal company names, internal Slack/Linear URLs, customer names, or anything that wouldn't make sense to a stranger.
- **Gitignore correctness**: `.env.local`, `.env*.local`, `node_modules`, `.next`, `.neon`, `conductor.json` (if Conductor-specific), build artifacts — all ignored. Nothing important *over*-ignored.
- **Repo metadata**: `package.json` `name`, `description`, `repository`, `license`, `author` filled in sensibly. No `"private": true` if the goal is OSS distribution (unless intentional — flag for confirmation).
- **OSS hygiene files** (note as missing if absent — most are 1-time, low-effort, high-signal):
  - `README.md` at root with badges/screenshot/quickstart
  - `CONTRIBUTING.md` (even a short one)
  - `CODE_OF_CONDUCT.md` (Contributor Covenant is fine)
  - `SECURITY.md` (where to report vulns)
  - `.github/ISSUE_TEMPLATE/` and `.github/PULL_REQUEST_TEMPLATE.md`
  - `.github/workflows/` with at least a typecheck/lint CI run on PRs
- **Dependency licenses**: spot-check `package.json` for anything copyleft (GPL/AGPL) that would force users into the same license. Usually fine, but call it out.

### 3. Code quality

Read whole files, not just diffs.

- **Type safety**: any `as any`, `// @ts-ignore`, `// @ts-expect-error` without a justifying comment? Implicit `any` in function signatures? `tsconfig.json` strict mode on?
- **Error handling at system boundaries**: does the auth callback handle the unhappy path? Do DB queries handle "not found" gracefully? Are errors logged with enough context?
- **Server/client boundary** (Next.js App Router): are `'use client'` directives necessary? Is anything secret leaking into a client component (env vars, tokens, internal IDs)?
- **Dead code**: unused exports, unused props, files no longer referenced.
- **Premature abstraction or speculative generality**: helpers used once, type unions modeling cases that don't exist yet, config knobs no one will turn.
- **Magic constants**: hardcoded paths, URLs, or IDs that should be named/centralized.

### 4. Architecture & structure

Ask: if a new contributor wanted to add a feature, would the structure tell them where it goes?

- **Domain boundaries**: are `lib/auth`, `lib/db`, `lib/<domain>` clearly separated? Is anything bleeding (e.g., DB queries inside components, auth logic inside route handlers)?
- **Layering**: are server-only modules clearly server-only? Any DB or secret imports reachable from a client component?
- **Config concentration**: env reads centralized in one module, or scattered? Drizzle config / db client instantiated once?
- **Naming consistency**: kebab vs camel filenames, plural vs singular folders, route handler conventions.
- **Folder weight**: any folder with one file that should be merged, or any one file doing the work of three?
- **Refactor candidates worth doing now** (vs. deferring): only suggest a refactor if (a) it materially improves DX or readability, (b) it's <2h of work, or (c) it would be painful to do later once contributors are merging in.

### 5. Security

This repo wires auth (WorkOS) and a DB (Neon/Drizzle). The bar is higher than a typical demo.

- **Middleware coverage**: does `middleware.ts` protect the right paths? Is the `unauthenticatedPaths` allowlist tight?
- **Session handling**: cookies set with `httpOnly`, `secure`, `sameSite` appropriate? Token refresh handled?
- **Redirect URI safety**: `NEXT_PUBLIC_WORKOS_REDIRECT_URI` validated against an allowlist server-side, not blindly trusted?
- **Input validation**: any route handler taking user input without validation (zod or equivalent)?
- **SQL**: Drizzle parameterizes by default, but check for any raw SQL via `sql\`...\`` template — confirm no string concatenation of user input.
- **CSRF**: state-changing routes (`POST`/`PUT`/`DELETE`) — Next.js Server Actions handle this, but explicit handlers need confirmation.
- **Logging**: nothing logs full tokens, full session cookies, or PII to stdout.

### 6. Documentation

`docs/` has `auth.md`, `database.md`, `getting-started.md`, `README.md` — verify they exist and are accurate.

- **Accuracy**: do the docs match the actual scripts and env vars? (Cross-reference `package.json` scripts and `.env.example`.)
- **Completeness**: is anything in the codebase that a contributor would need to understand undocumented? (e.g., the per-branch Neon DB pattern, the WorkOS install flow.)
- **Architecture overview**: is there a one-page "how this fits together" doc? If not, recommend adding one — it's the single highest-leverage doc for OSS.
- **Why this stack**: a paragraph explaining *why* WorkOS + Neon + Drizzle + Next.js. OSS visitors scan for this to decide if the repo's values align with theirs.
- **Inline comments**: any that explain *what* instead of *why*? Any stale comments referencing removed code?

### 7. Tooling, CI, and observability

- **CI**: any `.github/workflows/`? At minimum a PR check running `bun run lint` (which is `tsc --noEmit`). Recommend adding if missing.
- **Pre-commit / pre-push hooks**: none required, but lint-staged or similar can prevent the most common breakage. Don't recommend if it'd add friction.
- **Test strategy**: it's fine for a starter to have no tests *if* that's an explicit, documented decision. Otherwise flag the absence.
- **Logging/observability**: any provision for structured logs or error tracking, or is it `console.log`-only? For a starter, "no observability, by design, swap in your own" is a defensible answer if it's *stated*.
- **Dependency hygiene**: any obviously outdated or deprecated major versions? Anything with known critical advisories? Don't run an audit unless asked.

### 8. Performance & UX polish

Lowest priority for a starter, but worth a glance.

- **Bundle**: any heavy client-only library that should be server-rendered or lazy-loaded?
- **Loading states**: do auth-gated pages flash unauthenticated content?
- **Accessibility basics**: forms have labels, buttons have accessible names, color contrast not catastrophic.

## How to run

1. **Enumerate**. `git ls-files` to get the tracked file list. Read the high-signal files listed in *Scope of the audit*.
2. **Sweep for secrets and personal info first.** If you find any, that's the lead finding — stop and report it before the rest of the review so the user can rotate keys immediately.
3. **Work through categories 1–8 in order.** For each, jot internal notes. Skip categories that are clearly clean.
4. **Synthesize.** Collapse 30 raw observations into 5–15 findings ranked by impact × effort. Drop anything that's truly a nit.
5. **Write the report** in the format below.

## Output format

Open with a one-paragraph **verdict**: would you, as CTO, sign off on making this repo public this week? If no, what are the 1–3 blockers?

Then a **scorecard**, one line per category:

```
DX                       ✅ clean      |  🟡 minor  |  🔴 needs work  |  ⛔ blocker
OSS release safety       ...
Code quality             ...
Architecture             ...
Security                 ...
Documentation            ...
Tooling & CI             ...
Performance & UX         ...
```

Then the **findings**, grouped:

- **⛔ Blockers** (must fix before going public) — usually OSS-safety or security.
- **🔴 Should fix before launch** (visible impact on first-run DX, contributor onboarding, or code health).
- **🟡 Worth doing soon** (next 1–2 weeks; meaningful but not launch-gating).
- **💡 Worth considering** (defensible to defer; mention because deferring is a real choice).

For each finding, use this shape:

```
**Title** — one-line summary

Where: <file:line or directory>
Why it matters: <one sentence on the impact>
Suggested action: <one sentence on the fix, with exact command/path/snippet if useful>
Effort: <S / M / L>
```

Close with **what's already strong** — 2–4 bullets. A CTO review that only criticizes is uncalibrated.

## Don't

- **Don't auto-fix.** This skill is review + recommend. The user decides what lands.
- **Don't write a 5,000-word essay.** If your output exceeds ~2 pages of markdown, you're being exhaustive instead of high-signal.
- **Don't recommend tests-for-tests' sake, CI-for-CI's sake, or docs-for-docs' sake.** Recommend them when their absence will *actually bite* contributors or maintainers.
- **Don't pad with generic best-practice advice** ("consider adding Prettier", "consider adopting Conventional Commits") unless there's a specific repo-grounded reason.
- **Don't run `bun run dev`, migrations, or anything that mutates state.** Read-only audit.
- **Don't grade categories the repo doesn't have yet harshly.** A starter that hasn't shipped publicly is allowed to be missing CONTRIBUTING.md — call it out, but as 🟡 not ⛔.
- **Don't moralize about open source.** Stick to the technical and DX bar; leave philosophy out.
