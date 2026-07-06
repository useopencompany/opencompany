# Goat Brain v1 Implementation Tracker

Current phase: implementation complete; ready for review/discussion.

## Completed Changes

- Created this tracker.
- Updated `@opencompany/goat-brain` to the v1 taxonomy, schema-pack constant, structured timeline
  evidence ids, citation extraction, active-record citation validation, and richer query hits.
- Rebuilt the generated Goat Brain CLI bundle.
- Replaced the DB Brain helper internals with `goat.brain_documents` reads/writes and inline
  timeline, edge, folder, and version projections.
- Added migration `0088_goat_brain_v1_documents.sql` for legacy backfill, evidence ids, v1
  taxonomy constraints, and dropping `goat.brain_files`.
- Updated Goat chat and runner materialization to operate on `goat.brain_documents` through the
  existing agent-facing bundled CLI path.
- Updated Goat Electric scoping and collections for `brain_documents`, `brain_timeline_entries`,
  `brain_edges`, and `brain_folders`.
- Updated the Brain UI into a trust-panel MVP over the v1 taxonomy, live timeline evidence ids,
  citation copy text, and projected graph edges.
- Added conflict-copy behavior for concurrent sandbox edits so the live DB document is preserved and
  the sandbox write becomes a draft `conflicts_with` document.

## Open Blockers

- Live database inspection was not run because this shell has no `DATABASE_URL` or `POSTGRES_URL`.
  DB behavior was verified through package tests and runner sync/materialization tests.

## Verification Commands

- Passed: `bun run --filter @opencompany/goat-brain test`
- Passed: `bun run --filter @opencompany/db test`
- Passed: `bun run --filter @opencompany/runner test -- goat-brain`
- Passed: `bun run --filter @opencompany/goat test`
- Passed: `bun run typecheck`
- Passed: `bun run lint` (no errors; existing warnings remain in `apps/web`)
- Passed: `bun run format:check`
- Passed: `curl -I --max-time 10 http://127.0.0.1:3100/brain` returned `HTTP/1.1 200 OK`.

## Manual CLI/DB Verification Log

- Generated the bundled CLI from `packages/goat-brain/src/generated/cli-bundle.ts` into a temporary
  root and executed a full scenario with `node goat-brain.mjs`.
- Verified `folder list` returns the v1 folder taxonomy.
- Created an active company record with `--evidence-id ev-user-note`; the resulting Markdown used
  `### ev-user-note - <ISO timestamp>` and compiled truth cited `[^ev:ev-user-note]`.
- Created a project, appended evidence with `append-evidence`, linked it to the company, queried
  with graph hops, and verified query JSON included id, path context, type, status, compiled truth
  excerpt, and relation context.
- Rewrote the active company with a valid citation successfully.
- Rewrote the active company without a citation and verified the command failed with the active
  citation validation error.
- Created duplicate people records, merged one into the other, moved the project into `research`,
  and ran `delete --dry-run`.
- Ran `doctor`; it returned zero errors and expected weak-provenance warnings only for draft people
  records without timeline evidence.
- Live DB table inspection was skipped because no local database connection variables were present.
- Visual browser smoke testing was attempted against the running `/brain` page, but the in-app browser
  connection failed before attaching. The HTTP route smoke check passed.
