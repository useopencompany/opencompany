# External Skills Support — Implementation Summary

Status: implemented on branch `louismorgner/add-future-doc` (2026-06-04). Full workspace
typecheck, lint, and tests pass. One manual step remains — see [Pending](#pending).

Research/design background: [`docs/future-concepts/external-skills-support-research.md`](docs/future-concepts/external-skills-support-research.md).
User-facing format docs: [`docs/agent-file.md`](docs/agent-file.md) (`skills` section).

## What it does

A user finds a skill (a public GitHub repo, or a skills.sh page, containing a `SKILL.md`),
types `@skill` in the agent editor → **"Add skill from GitHub URL"**, pastes the URL, previews
it, and confirms. The skill is snapshotted into the workspace, an `@skill/<id>` mention is
inserted into the agent body, and at session start the runner materializes it read-only into
the sandbox under `skills/<id>/` and advertises it in the system prompt — exactly like the
built-in skills, just sourced externally.

## Design decisions

1. **Workspace-scoped reusable catalog.** One `workspace_skill_snapshots` table; any agent in
   the workspace references a skill via `@skill/<id>`. Deduped by content hash.
2. **Track branch latest (not pinned).** The runner re-resolves each skill to its branch HEAD
   on session start (5-minute freshness TTL + cheap HEAD revalidation). Always fresh.
   Reproducibility was traded away deliberately; pinning can be added later with no schema
   change (snapshots already store `resolved_commit` + `integrity`).
3. **Public GitHub + skills.sh only.** Hard SSRF allowlist (`api.github.com` /
   `raw.githubusercontent.com`); skills.sh URLs resolve through their backing GitHub repo.
   Unauthenticated requests (low GitHub rate limits) is a known V1 limitation. Private repos
   and well-known discovery are deferred.
4. **Inline `@skill` → modal.** Matches the existing mention UX (mirrors the schedule action).

## Architecture & data flow

```
Editor (@skill → "Add skill from GitHub URL")
  → POST /api/skills/resolve   preview (parse URL, fetch, validate, hash) — no DB write
  → POST /api/skills           persist snapshot to workspace catalog
  → insert @skill/<id> into the body
Save (updateAgent)
  → deriveAgentConfigFromBody(body, { skills: workspaceCatalog })
  → @skill/<id> matched → external ref written into agents.config.skills
  → serializeAgentFile(..., skills) → frontmatter object
Run (runner host — trusted, never the sandbox)
  → for each external skill: re-resolve to branch HEAD (TTL + HEAD check), upsert snapshot
  → materialize builtin files (code) + external files (DB) → skills/<id>/… root-owned 444/555
  → system prompt advertises builtin + external skills; agent reads via read_skill
```

The sandbox never fetches remote content. All resolution happens in the web app (add/preview)
or the trusted runner host (refresh-on-run).

## Data model

### `.agent` frontmatter

`AgentSkillReference` is a union. Built-ins stay bare strings (back-compat); external skills
serialize as objects carrying provenance + a denormalized name/description (for the pure
prompt-advertisement path). File contents are **not** in the `.agent` file.

```yaml
skills:
  - agent-self-edit                      # built-in (string)
  - id: improve-codebase-architecture    # external (object)
    name: Improve Codebase Architecture
    description: Analyze codebases for architectural friction.
    source:
      type: github                       # "github" | "skills.sh"
      url: https://github.com/mattpocock/skills
      ref: main                          # branch/tag tracked
      path: skills/improve-codebase-architecture
```

### DB: `workspace_skill_snapshots`

Refreshable cache, workspace-scoped. Columns: `id`, `workspace_id` (fk cascade), `skill_id`
(mount slug), `name`, `description`, `source_type`, `source_url`, `requested_ref`,
`skill_path`, `resolved_commit`, `integrity` (`sha256:…`), `files` (jsonb `AgentSkillFile[]`),
`file_count`, `total_bytes`, `last_resolved_at`, `schema_version`, timestamps.
Unique `(workspace_id, source_url, requested_ref, skill_path)`; index `(workspace_id, skill_id)`.
Migration: `drizzle/0039_fuzzy_maelstrom.sql`.

## Milestones

- **M1 — Contract + skill-erasure fix.** Union types; `normalizeAgentSkills` /
  `normalizeExternalSkillReference`; mixed string/object serialization; `resolveEnabledSkillMetadata`;
  `computeSkillFolderIntegrity`; config.ts advertisement swap. **Fixed a latent bug**:
  `serializeAgentFile` was dropping `skills` on the web save path (and other sites), so any
  external skill would have been silently erased on save.
- **M2 — DB + shared resolver.** `workspace_skill_snapshots` table + migration; shared resolver
  (`packages/agent-runtime/src/skill-resolver.ts`: URL parsing, SSRF guard, SKILL.md discovery,
  validation, hashing, slug/collision handling, injected fetcher); web `lib/skills/{resolver,snapshots}.ts`;
  `/api/skills` + `/api/skills/resolve` routes.
- **M3 — Web save wiring.** `deriveAgentConfigFromBody` + `collectBodyMentions` match
  `@skill/<id>` against the injected workspace catalog; `buildConfigMentionResolver` /
  `mentionIdDisplayText` render skill pills; `updateAgent` loads snapshots and threads them
  through; body is authoritative (removing the mention drops the skill).
- **M4 — Runner refresh + materialize.** `materializeSkillsForSession` merges builtin (code)
  + external (DB) files; `loadExternalSkillFiles` does HEAD revalidation + TTL, upserts, and
  skips+warns on failure; resolution is in the runner host, files mounted read-only.
- **M5 — Editor UX.** New `skill` mention kind + "Skills" category; `@skill/<id>` pills;
  `AddSkillDialog` (resolve → preview → candidate picker → confirm) that inserts the mention
  and refreshes the catalog.
- **M6 — Docs.** `docs/agent-file.md` updated; this summary.

## Security model & tradeoffs

- Re-resolution runs in the trusted runner host, **never** in the sandbox. Files mount
  root-owned read-only (444/555); generic file tools stay restricted to `work/ brain/ agent/`;
  `read_skill` is the only reader.
- User confirms the skill source once at add time. Branch updates are then trusted implicitly
  — the explicit reproducibility tradeoff for "track latest".
- Every resolve/re-resolve enforces: SSRF host allowlist, file-count + byte limits, binary +
  symlink + path-traversal rejection, public repos only.
- Self-edit (`update_agent_file`) is preserve-only for skills — it can't add or resolve
  external skills (no resolver injected). Minor asymmetry: removing `@skill/x` from the body
  drops it on the web save path but is preserved on the self-edit path.

## Files changed / added

**`packages/agent-runtime/src`**
- `types.ts` — `AgentSkillReference` union, `AgentSkillSource`, `AgentExternalSkillReference`,
  `AgentSkillFile` (moved here), `isExternalSkillReference`.
- `skills.ts` — `normalizeAgentSkills` (+ external), `normalizeExternalSkillReference`,
  `resolveEnabledSkillMetadata`, `resolveEnabledBuiltinSkillFiles` (renamed from
  `resolveEnabledSkills`), `computeSkillFolderIntegrity`, `isValidSkillMountId`.
- `skill-resolver.ts` (new) — `parseSkillUrl`, `slugifySkillName`, `ensureSkillMountId`,
  `parseSkillFrontmatter`, `discoverSkillDirectories`, `validateSkillFiles`, `resolveSkill`,
  `createGitHubSkillFetcher`, types.
- `agent-file.ts` — mixed string/object skill serialization (fixed key order); round-trip
  count guard.
- `mentions.ts` — `@skill/<id>` derivation + `AgentConfigDerivationSkill`; skill pills in
  `buildConfigMentionResolver` / `mentionIdDisplayText`.
- `config.ts` — advertisement via `resolveEnabledSkillMetadata` (+ provenance text).
- Tests: `skills.test.ts`, `skill-resolver.test.ts`, `mentions.test.ts`, `agent-file.test.ts`.

**`packages/db/src`**
- `schema.ts` — `workspaceSkillSnapshots`. Migration `drizzle/0039_fuzzy_maelstrom.sql`.

**`apps/web`**
- `lib/skills/{resolver,snapshots,client}.ts` (new), `lib/skills/snapshots.test.ts`.
- `app/api/skills/route.ts`, `app/api/skills/resolve/route.ts` (new).
- `lib/agents/actions.ts` — load catalog, thread into derivation, `nextSkills`, fixed all
  `serializeAgentFile` skill-omission sites.
- `lib/agents/config.ts`, `lib/agents/materialize.ts` — thread/preserve skills.
- `components/agent-editor/{tools,MentionList,mentionSuggestion,AgentEditor}.tsx`,
  `AddSkillDialog.tsx` (new); `components/AgentDetail.tsx` — skills query, dialog, editor ref.

**`apps/runner/src`**
- `skill-snapshots.ts` (new) — `loadExternalSkillFiles` (HEAD revalidation, upsert, skip+warn).
- `skills.ts` — merge builtin + external in `materializeSkillsForSession({ workspaceId })`.
- `session-lifecycle.ts` — pass `workspaceId`; preserve skills in prepared `.agent`.
- Tests: `skills.test.ts`, `skill-snapshots.test.ts`.

## Pending

The migration `drizzle/0039_fuzzy_maelstrom.sql` (creates `workspace_skill_snapshots`) is
**generated but not yet applied** — `bun run db:migrate` failed in the agent session with
`password authentication failed for user 'neondb_owner'` (a stale/rotated dev credential in
the available infisical context, not a code issue). **Run `bun run db:migrate` with a working
dev env before testing the runtime end-to-end.**

## End-to-end verification (after the migration)

In the editor: `@skill` → "Add skill from GitHub URL" → paste a public repo
(e.g. `https://github.com/mattpocock/skills`) or a skills.sh URL → pick a skill if prompted →
confirm. The `@skill/<id>` pill is inserted. Start a session and confirm the agent can
`read_skill` it under `skills/<id>/`. Push a commit to the branch and confirm the next run
picks up the change.
