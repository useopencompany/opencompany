# Goat Skill Import (V1 of Plugins Alignment) Plan

Date: 2026-08-07

Design background: [Goat Plugins — Aligning Skills & Integrations with the Agent Plugins
Standard](../../future-concepts/goat-plugins-alignment-proposal.md) (§4 has the settled
decisions this plan implements; §5 has the V1/V2/V3 phasing this is V1 of).

## Strategy

Ship the two pieces of V1 from the proposal: (1) import a bare `SKILL.md` (GitHub/skills.sh URL)
directly into a workspace's existing skill catalog, read-only, no `mcp.json`/integration half
yet; (2) a one-line system-prompt nudge so the chat agent proactively checks the skill catalog
instead of only using it when the user explicitly `@mention`s one.

No changes to integrations, no new trust surface, no schema change beyond adding source-tracking
columns to the table that already exists. V2 (generic MCP-backed integrations) is a separate,
later plan.

Key existing pieces this reuses rather than rebuilds:
- `packages/agent-runtime/src/skill-resolver.ts` — the GitHub/skills.sh URL parser, fetcher,
  `SKILL.md` discovery/validation/hashing already built for `apps/web`'s external skills.
- `goatSkills` (`packages/db/src/goat-schema.ts:2701`) — already the single workspace skill
  catalog; imported skills become more rows in the same table rather than a parallel model,
  per decision 3 in the proposal (import and hand-authoring are two entry points, one table).
- The chat route already exposes a `skills` catalog + self-serve `execute` tool to the model
  every turn (`apps/goat/app/api/chat/route.ts:1008-1069`) — the model can already load any
  workspace skill by id mid-conversation. The "nudge" is a copy change to make it use this
  proactively, not new plumbing.

## Implementation Checklist

- [ ] Migration: add nullable `source_type` (`'github' | 'skills_sh'`), `source_url`,
      `source_ref`, `source_path`, `resolved_commit`, `integrity` columns to `goat.skills`.
      `NULL source_type` = hand-authored (unchanged behavior). Partial unique index on
      `(workspace_id, source_url, source_ref, source_path)` where `source_type IS NOT NULL`, to
      prevent duplicate imports of the same skill.
- [ ] `apps/goat/lib/skill-import.ts` (new): thin Goat wrapper around
      `packages/agent-runtime/src/skill-resolver.ts` — `previewGoatSkillImport(url)` (no DB
      write; returns name/description/instructions/source metadata, or a clear error) and
      `resolveGoatSkillImportForCreate(url)`. Files beyond `SKILL.md` (scripts/references) don't
      block the import — surface a non-blocking warning ("N supporting files weren't imported")
      since Goat skills are instructions-only in V1 per the proposal's phasing.
- [ ] `apps/goat/lib/skills.ts`: add `createImportedGoatSkill(...)`; update `updateGoatSkill` to
      reject edits when `sourceType` is set (`{ ok: false, message: "This skill was imported
      from {sourceUrl} and can't be edited here. Remove and re-import if the source changed." }`).
      `archiveGoatSkill` unaffected — uninstall still works for imported skills.
- [ ] `apps/goat/lib/skill-actions.ts`: add `previewGoatSkillImportAction(url)` and
      `importGoatSkillAction(url)`, gated by the same `requireWorkspaceAdmin()` used by
      `createGoatSkillAction`/`updateGoatSkillAction`. Dedup: importing an already-imported
      source returns the existing slug instead of creating a duplicate row.
- [ ] `/settings/skills` UI: add "Import from a link" alongside the existing "Create skill"
      entry point (`GoatSkillsSettingsRoute` / underlying list component in `GoatRoutes.tsx`).
      Dialog: paste URL → preview (name, description, rendered instructions, source link, any
      "not imported" warning) → confirm → creates the row, navigates to
      `/settings/skills/[slug]`.
- [ ] `GoatSkillEditorRoute` / skill editor page: read-only rendering path when
      `skill.sourceType` is set — disabled fields, a "Imported from {sourceUrl} ·
      {resolvedCommit short}" badge, Archive/Remove still available, no Save.
- [ ] System prompt nudge: locate the exact description/system-prompt text wrapping the `skills`
      catalog+execute object around `apps/goat/app/api/chat/route.ts:1008` (confirm exact
      insertion point when picking this up — it may be a tool `description` field or a nearby
      prompt-block builder) and add one line: check the skill catalog for anything relevant to
      the current task before assuming it's unavailable, don't wait for an explicit `@mention`.
- [ ] Tests: `skill-import.ts` preview/resolve (mirror `skill-resolver.test.ts` fixtures),
      `skill-actions.ts` gating + dedup + read-only-rejection, a focused test that the chat
      route's skill catalog still includes imported skills once active.
- [ ] `bun run db:migrate` against the sandbox-isolated dev DB; watch for the stale-credential
      failure noted as a known issue in `skills-implementation.md`'s Pending section — if it
      recurs here too, it's an environment issue, not a code issue.

## Files Expected To Change

- `packages/db/src/goat-schema.ts` (+ new `drizzle/NNNN_*.sql` migration)
- `apps/goat/lib/skill-import.ts` (new)
- `apps/goat/lib/skills.ts`
- `apps/goat/lib/skill-actions.ts`
- `apps/goat/components/GoatRoutes.tsx` and the skill list/editor components it wires
  (confirm exact component names when implementing — `GoatSkillsSettingsRoute`,
  `GoatSkillEditorRoute`)
- `apps/goat/app/api/chat/route.ts` (system-prompt/tool-description copy only)
- Focused tests beside each touched module

## Product Behavior

- `/settings/skills` (admin only, matching existing skill-authoring gate): "Create skill" and
  "Import from a link" sit side by side. Import accepts a GitHub URL (skills.sh resolves through
  its backing GitHub repo, same as `apps/web`).
- An imported skill appears in the same list as hand-authored ones, no separate tab — badge
  indicates "Imported" with a link back to source. Removing the `@skill/<slug>` mention or
  archiving the skill works identically regardless of origin.
- Imported skills are immediately usable via `@skill/<slug>` in chat and via the model's own
  `skills.execute` tool once `status` is active (see open question below on default status).
- No re-resolution/update-checking in V1 — content is captured at import time. (This is a
  deliberate scope cut vs. `apps/web`'s branch-HEAD-tracking: Goat has no "runner materializes
  at session start" hook to piggyback re-resolution on the way `apps/web` does, and building one
  just for this is out of scope for V1. Worth flagging explicitly since it's a real behavior gap
  vs. `apps/web`'s external skills, not an oversight.)

## Open Implementation-Level Questions

Smaller than the five decisions already settled in the proposal, but worth a nod before/while
building rather than silently assuming:

1. **Default status on import:** active immediately (content is already complete, unlike a
   blank hand-authored draft), or land as `draft` requiring a manual activate step? Leaning
   active — nothing to fill in before it's usable.
2. **Re-import of the same source:** block with a friendly "already imported, here's the
   existing skill" message (current plan), or allow multiple independent imports of the same
   URL? Leaning block/reuse — avoids silent catalog duplication.

## Risks

- Read-only enforcement only helps if every mutation path checks `sourceType` — if a future
  change adds another way to write `instructions` (bulk edit, API route, etc.) it needs the same
  guard. Centralizing the check in `updateGoatSkill` (data layer, not just the UI) covers this.
- `skill-resolver.ts` is shared with `apps/web`; changes there need both apps' test suites run,
  not just Goat's.
- The "N supporting files weren't imported" warning needs to be honest and visible enough that a
  user importing a skill that relies on bundled scripts doesn't silently get a broken/incomplete
  experience — worth a real manual check against a skill that actually has a `scripts/` folder,
  not just an instructions-only one.

## Verification Plan

- `bun test apps/goat/lib/skill-import.test.ts apps/goat/lib/skill-actions.test.ts` (new)
- `bun test apps/goat/lib/skills.test.ts` (extended for read-only rejection)
- `bun run typecheck`
- `bun run lint` / `bun run format:check`
- Manual: import a real public skill (e.g. the same `mattpocock/skills` repo used in `apps/web`'s
  verification), confirm read-only editor, confirm `@skill/` mention and the model's own
  `skills.execute` both surface it, confirm archiving removes it from the mention catalog.
- UI click-through in the browser per `AGENTS.md`'s UX Expectations — terminal checks alone
  aren't enough for the import dialog and read-only editor state.

## Implementation Log

(empty — plan not yet executed)
