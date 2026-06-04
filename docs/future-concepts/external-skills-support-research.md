# External Skills Support Research

Context note for future OpenCompany work on user-configurable skills.

Created: 2026-06-04

## Goal

OpenCompany currently has a hidden built-in skill, `agent-self-edit`, with working runtime mechanics. The next product step is allowing users to type `@skill` in an agent config and attach a skill from a web source, initially something like a GitHub repository that contains at least a `SKILL.md`.

This document captures the current repo behavior, what skills.sh does technically, and a recommended implementation direction for OpenCompany.

## Current OpenCompany Mechanics

Relevant files:

- `docs/agent-file.md`
- `packages/agent-runtime/src/skills.ts`
- `packages/agent-runtime/src/config.ts`
- `packages/agent-runtime/src/agent-file.ts`
- `packages/agent-runtime/src/types.ts`
- `apps/runner/src/skills.ts`
- `apps/runner/src/sandbox.ts`
- `apps/runner/src/tool-dispatcher.ts`
- `apps/runner/src/self-edit-gate.ts`
- `apps/web/components/agent-editor/tools.ts`
- `apps/web/components/agent-editor/MentionList.tsx`

The current `.agent` contract supports:

```yaml
skills:
  - agent-self-edit
```

Current behavior:

- Skill references are simple ids: `AgentSkillReference = { id: string }`.
- `normalizeAgentSkills` keeps known built-in ids and drops unknown ids.
- `resolveEnabledSkills` always includes built-in `defaultEnabled` skills.
- Built-in skill definitions live in code, including their `files`.
- Runtime prompt advertises each enabled skill's name, description, and `skills/<id>/SKILL.md`.
- Runner materializes enabled skill files into the sandbox under `skills/<id>/`.
- Skill files are root-owned, world-readable, and read-only.
- Generic file tools are blocked from `skills/`.
- The model reads skill files only through `read_skill`.
- `read_skill` validates both `skillId` and relative file path.
- `update_agent_file` is gated on reading `agent-self-edit` first.

The existing sandbox model is good. External skills should preserve it: resolve and cache skill content before the run, then materialize immutable files read-only into `skills/<id>/`.

## skills.sh Findings

Primary references:

- Skill page: `https://www.skills.sh/mattpocock/skills/improve-codebase-architecture`
- Docs: `https://www.skills.sh/docs`
- CLI source: `https://github.com/vercel-labs/skills`
- Local clone used for inspection: `.context/skills-sh`

Important source files in the skills.sh CLI:

- `.context/skills-sh/src/source-parser.ts`
- `.context/skills-sh/src/skills.ts`
- `.context/skills-sh/src/blob.ts`
- `.context/skills-sh/src/installer.ts`
- `.context/skills-sh/src/skill-lock.ts`
- `.context/skills-sh/src/local-lock.ts`
- `.context/skills-sh/src/providers/wellknown.ts`
- `.context/skills-sh/src/plugin-manifest.ts`

### Source Resolution

skills.sh accepts several source forms:

- Local paths.
- GitHub shorthand: `owner/repo`.
- GitHub shorthand with subpath: `owner/repo/path/to/skill`.
- GitHub shorthand with skill filter: `owner/repo@skill-name`.
- GitHub tree URLs: `https://github.com/owner/repo/tree/branch/path`.
- GitLab URLs and generic git URLs.
- Non-GitHub HTTPS well-known discovery URLs.

It supports refs via URL fragments for git-like sources:

- `owner/repo#branch-or-tag`
- `owner/repo#branch@skill-name`

It sanitizes subpaths and rejects `..` path traversal segments.

### Discovery

skills.sh discovers skills by finding directories containing `SKILL.md`.

Validation boundary:

- `SKILL.md` must have frontmatter.
- `name` must exist and be a string.
- `description` must exist and be a string.
- Internal skills can be hidden unless explicitly requested.

Discovery searches common locations first:

- Repo root.
- `skills/`.
- `skills/.curated/`.
- `skills/.experimental/`.
- `skills/.system/`.
- Many agent-specific folders such as `.agents/skills`, `.claude/skills`, `.codex/skills`, `.opencode/skills`, etc.

If priority discovery fails, it falls back to recursive search with a depth limit.

### Install Model

skills.sh installs into developer filesystem paths, not into a runtime:

- Canonical project path: `.agents/skills/<sanitized-skill-name>`.
- Agent-specific paths may symlink to the canonical path.
- Copy mode is also supported.
- It excludes some files or directories, such as `.git`, `metadata.json`, `__pycache__`, and `__pypackages__`.
- It dereferences symlinks while copying and skips broken symlinks.

This does not map directly to OpenCompany because OpenCompany runs ephemeral cloud sandboxes. We should not copy the dotfolder/symlink install model. We should copy the snapshot and locking ideas.

### Locking

skills.sh records deterministic lock metadata.

Project lock file:

- `skills-lock.json`
- Intended to be committed.
- Minimal and timestamp-free to avoid merge conflicts.
- Stores:
  - source
  - ref
  - sourceType
  - skillPath
  - computedHash

Global lock file:

- `.skill-lock.json`
- Stored under XDG state or home `.agents`.
- Stores timestamps and richer metadata.

For OpenCompany, this implies `.agent` should not store only `@skill/foo`; it should store provenance and integrity for external skills.

### Blob Fast Path

For some allowlisted GitHub owners, skills.sh avoids cloning:

1. Fetch GitHub recursive tree.
2. Find `SKILL.md` paths.
3. Fetch each `SKILL.md` from `raw.githubusercontent.com` for frontmatter.
4. Convert skill name to slug.
5. Fetch full file snapshot from `skills.sh/api/download/:owner/:repo/:slug`.
6. Fall back to git clone if any step fails.

This is useful conceptually, but OpenCompany should not depend on skills.sh as the canonical fetch path. Use GitHub contents/tree APIs or git archive/clone directly, then store our own snapshot.

### Well-Known Discovery

skills.sh supports:

- `/.well-known/agent-skills/index.json`
- legacy `/.well-known/skills/index.json`

Current schema supports:

- `skill-md`
- `archive`
- `url`
- `digest`

It includes important guardrails:

- Valid skill names only.
- Description length limit.
- SHA-256 digest requirement.
- Archive unpacked size limit.
- Archive file count limit.
- Safe relative paths only.

This is a strong future direction for OpenCompany, but GitHub-only should come first to reduce SSRF and arbitrary-fetch risk.

## Specific Skill Page: improve-codebase-architecture

Page:

`https://www.skills.sh/mattpocock/skills/improve-codebase-architecture`

Observed details:

- Install command: `npx skills add mattpocock/skills --skill improve-codebase-architecture`
- Repo: `mattpocock/skills`
- Name: `improve-codebase-architecture`
- Description: improves codebase architecture.
- It contains at least:
  - `SKILL.md`
  - `LANGUAGE.md`
- The `SKILL.md` references `LANGUAGE.md`, so installing only `SKILL.md` would break the skill's progressive disclosure contract.

Implication for OpenCompany:

- External skill ingestion must snapshot the whole skill directory.
- `read_skill({ skillId, path })` must support referenced files, as it already does.

## Recommended OpenCompany Design

Treat external skills as immutable reviewed snapshots.

### `.agent` Format

Keep built-ins as string shorthand for compatibility:

```yaml
skills:
  - agent-self-edit
```

Allow external object entries:

```yaml
skills:
  - id: improve-codebase-architecture
    name: Improve Codebase Architecture
    description: Analyze codebases for architectural friction and propose concrete improvements.
    source:
      type: github
      url: https://github.com/mattpocock/skills.git
      ref: main
      resolvedCommit: abc123
      path: skills/improve-codebase-architecture
    integrity: sha256:...
```

Notes:

- `id` is the mounted id under `skills/<id>/`.
- `name` and `description` come from `SKILL.md` frontmatter.
- `source.ref` is what the user requested.
- `source.resolvedCommit` is what OpenCompany actually fetched.
- `source.path` is the skill directory path in the repo.
- `integrity` hashes the full normalized skill folder contents.

### `@skill` Mention

Recommended body syntax:

```md
Use @skill/improve-codebase-architecture when evaluating architectural quality.
```

The body mention should enable the skill, but the frontmatter object should carry the resolved metadata. If the body has `@skill/foo` without a matching resolved skill reference, the editor should show it as unresolved and the runtime should not mount it.

This mirrors existing product behavior: body mentions are the source of truth for what the agent uses, but frontmatter carries deterministic runtime metadata.

### Storage

Add server-side snapshot storage rather than fetching during runner startup.

Possible schema:

- `agent_skill_snapshots`
  - `id`
  - `workspace_id`
  - `source_type`
  - `source_url`
  - `requested_ref`
  - `resolved_commit`
  - `skill_path`
  - `skill_id`
  - `name`
  - `description`
  - `integrity`
  - `status`
  - `created_at`
  - `updated_at`
- `agent_skill_snapshot_files`
  - `snapshot_id`
  - `path`
  - `content`
  - `size_bytes`

Use unique key:

`workspace_id + source_type + source_url + resolved_commit + skill_path + integrity`

This allows reuse across agents and deterministic session materialization.

### Resolver

V1 should support public GitHub HTTPS repo and tree URLs only.

Resolver flow:

1. Parse and validate source URL.
2. Resolve branch/tag to commit SHA.
3. Discover candidate `SKILL.md` paths.
4. If multiple skills are found, require the user to choose one.
5. Fetch the whole skill directory.
6. Validate:
   - `SKILL.md` exists.
   - Frontmatter `name` and `description` are strings.
   - File paths are relative and cannot escape the skill dir.
   - File count is under a limit.
   - Total bytes are under a limit.
   - Text files only for v1.
   - No `.git`, `node_modules`, binaries, or unsafe symlink behavior.
7. Compute content hash.
8. Store snapshot.
9. Return preview metadata to the editor.

Avoid fetching external sources at runner startup. Startup should only read already-stored snapshot rows.

### Runner

Extend `materializeSkillsForSession`:

- Built-ins continue to come from code.
- External snapshots come from DB through session config.
- Materialize both into the same `skills/<id>/` tree.
- Preserve root-owned, read-only permissions.
- Preserve `read_skill` path validation.

The model should not know whether a skill is built-in or external except possibly source/provenance text in the advertised skill list.

### Editor UX

Add a Skills category to `@` suggestions.

Initial interaction:

1. User types `@skill`.
2. Choose "Add skill from GitHub URL".
3. Paste URL.
4. Server resolves candidates.
5. User selects a skill if multiple are found.
6. Show preview:
   - name
   - description
   - source repo/ref/path
   - resolved commit
   - file list
   - total size
7. User confirms.
8. Editor inserts `@skill/<id>`.
9. Save writes external skill object into frontmatter.

The editor should also display already-added skills as mention options.

### Updates

Do not auto-update branch refs silently.

Recommended update behavior:

- Show "Update available" when the requested ref resolves to a newer commit.
- Let user preview diff metadata and confirm.
- Store a new snapshot.
- Update `.agent` frontmatter to the new resolved commit and integrity.

This keeps agent behavior reproducible.

## Security Notes

Skills are prompt supply chain. They are not executable plugins in OpenCompany, but they can still instruct the agent to misuse tools, exfiltrate context, or make harmful edits.

V1 should:

- Support only GitHub HTTPS public repositories.
- Pin resolved commit.
- Store full folder hash.
- Require user confirmation before attaching.
- Display source and resolved commit in the editor.
- Never mount unreviewed remote content fetched during a run.
- Never allow skill files to be edited from generic tools.
- Limit file count and byte size.
- Reject binary files and path traversal.
- Avoid arbitrary HTTP fetch until well-known discovery is implemented with SSRF controls.

Future well-known support should require digest verification and strict network allow/deny behavior.

## Open Questions

- Should external skills be workspace-scoped reusable assets, or only embedded per-agent through `.agent` provenance?
- Should private GitHub repos be supported through existing GitHub installation auth, or deferred?
- Should skill ids be globally unique per agent only, or workspace-wide?
- Should user approval happen on every new snapshot, or can workspace admins approve a skill source once?
- Should skills be visible as reusable catalog entries in settings?
- Should self-edit be allowed to add external skills, or only mention already-approved ones?

## Suggested First Implementation Milestone

Build a GitHub-only, manually confirmed flow:

1. Extend runtime types and parser/serializer for external skill objects.
2. Add DB snapshot tables and migration.
3. Add resolver module with unit tests for URL parsing, discovery, validation, hashing, and path safety.
4. Add API route to resolve/preview a GitHub skill URL.
5. Add editor UI for `@skill` and "Add from GitHub URL".
6. Extend session payload and runner materialization.
7. Add tests:
   - parse/serialize `.agent`
   - unknown/unresolved skills are dropped or marked invalid
   - external files materialize read-only
   - `read_skill` can read secondary files
   - unsafe paths and oversized skills are rejected

