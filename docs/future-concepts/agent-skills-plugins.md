# Agent Skills and Agent Plugins 1.0.0 implementation plan

- Status: Implemented
- Date: 2026-08-21
- Standards:
  [Agent Skills](https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx) and
  [Agent Plugins 1.0.0](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md)

## Outcome

opencompany will load official Agent Skills without rewriting them and install official Agent
Plugins as immutable workspace packages. The first release implements the portable core directly:

- strict Agent Skills with complete multi-file bundles;
- plugin manifests and immediate-child `skills/` components;
- approved stdio MCP servers in coding sandboxes;
- immutable skill and plugin versions in Chats and Tasks; and
- writable plugin data that survives sandbox replacement and plugin replacement.

This is a clean cutover. Existing opencompany-only skills, compatibility parsers, reconstructed
`SKILL.md` files, legacy restore paths, and dormant workspace skill tables are deleted. There is no
dual-read period, automatic conversion, or legacy fallback in the new runtime.

The design intentionally stops at the standards' useful minimum. It does not introduce a plugin
registry, arbitrary Git remotes, HTTP MCP, a plugin SDK, dependency resolution, or a generic package
manager.

## Product decisions

1. **Official artifacts only.** New skills must pass strict Agent Skills validation. Invalid plugin
   manifests are rejected; invalid skills inside an otherwise valid plugin are skipped and reported,
   as required by Agent Plugins 1.0.0.
2. **Exact versions are durable.** A Chat or Task refers to immutable bundle and plugin IDs, never a
   slug or the workspace's current row.
3. **Standalone and plugin skills stay separate.** Plugin skills are not projected into the
   standalone skills table. Catalog and runtime queries combine them, with standalone skills taking
   precedence on name collisions.
4. **MCP execution requires approval.** Installing a plugin does not start its MCP servers. An admin
   must approve the exact plugin integrity before stdio MCP becomes available.
5. **Plugin data is durable.** `PLUGIN_DATA` is restored before launch and checkpointed after use. It
   is keyed by workspace and plugin name so replacing a plugin package does not erase its data.
6. **Legacy state is removed.** Old skill rows and snapshots are not migrated. The dormant public
   workspace skill/sync tables and their unused code are dropped.

## Conformance boundary

### Agent Skills

The loader supports the official six frontmatter fields:

- required `name` and `description`;
- optional `license`, `compatibility`, `metadata`, and `allowed-tools`.

Validation is strict and shared by standalone imports and plugin skill discovery. The name must
match the containing directory. Unknown top-level frontmatter fields are rejected. The existing
top-level `command` extension and slash-command behavior are removed; `metadata` is stored but does
not gain opencompany-specific behavior in this release.

Every file under the skill directory is retained as raw bytes, subject only to documented client
size limits and filesystem-safety checks. The executable bit is retained. Symlinks, submodules,
`.git`, absolute paths, traversal, and paths escaping the selected root are rejected.

The runtime follows progressive disclosure:

1. advertise every available skill's name and description;
2. return the selected skill's `SKILL.md` body on activation; and
3. read bundled resources only on demand.

Coding agents receive the original directory on disk. Main Chat receives a chunked
`read_skill_file` tool for tier-three access.

### Agent Plugins 1.0.0

The loader validates root `plugin.json` against the published 1.0.0 contract before inspecting any
component. Unknown top-level fields are reported and ignored; other manifest violations reject the
package. Unimplemented extension namespaces are ignored without validating their values. Only
immediate child directories of `skills/` are discovered.

The first MCP implementation supports **stdio only**, which is sufficient for an Agent Plugins MCP
client. The loader still recognizes and validates streamable HTTP and SSE entries, but reports them
as unsupported and does not launch them. Invalid `mcp.json` documents disable MCP for the plugin
without discarding valid skills; invalid server entries are skipped and reported at their specified
failure boundary.

Main Chat is a skills-only Agent Plugins client. Codex and Claude coding sandboxes are the MCP
runtime surface.

### Client policies

The standards leave installation and resource limits to clients. The first release supports public
GitHub and `skills.sh` sources already recognized by the resolver. A ref is resolved to a commit
before preview, and installation verifies the same commit and integrity again.

Initial limits:

| Artifact | Files | Total bytes | Bytes per file |
| --- | ---: | ---: | ---: |
| Skill | 64 | 1 MiB | 512 KiB |
| Plugin | 512 | 16 MiB | 2 MiB |
| Plugin data archive | n/a | 32 MiB | n/a |

These limits are product policy, not extensions to either file format.

## Minimal data model

### Immutable skill bundles

`goat.skill_bundles` stores one validated, immutable skill version:

- `id`, `workspace_id`, and `integrity`;
- parsed name, description, license, compatibility, metadata, and allowed-tools;
- derived Markdown body for model activation;
- source URL, selected path, ref, and resolved commit; and
- creation timestamp.

`goat.skill_bundle_files` stores `(bundle_id, path, content bytea, executable, size_bytes)`. Raw bytes
are the authority. UTF-8 decoding is performed only for `SKILL.md`; other resources may be binary.

The integrity algorithm is new and has no legacy mode. It hashes each sorted relative path, raw
content, and executable bit with unambiguous length delimiters. A unique
`(workspace_id, integrity)` constraint avoids duplicate storage within a workspace.

`goat.skill_installations` is the small mutable workspace record for standalone skills. It contains
`id`, `workspace_id`, spec name, `bundle_id`, enabled/archive state, and timestamps. A live workspace
may have only one standalone installation for a name. Imported bundles are never edited; replacing
a skill creates a new bundle and moves the installation pointer.

### Plugins remain separate

`goat.plugins` stores one immutable installed package:

- workspace, manifest name, status, and parsed manifest;
- source provenance, resolved commit, and package integrity;
- normalized valid stdio MCP entries and the install report; and
- `mcp_approved_integrity`, nullable until an admin approves this exact package.

`goat.plugin_files` stores the complete raw package using the same byte and executable columns as
skill bundle files. `goat.plugin_skills` maps `(plugin_id, skill_name)` to an immutable
`skill_bundle_id`. Copying the skill subset into a bundle is deliberate: all skill activation and
snapshot code then has one read path.

Plugin package rows and files are retained after archive while a Chat or Task references them.
There is no in-place plugin update in the first release. Replacing a plugin means archiving it and
installing a newly resolved immutable package.

### Snapshots use immutable IDs

Replace the old content-copying `goat.chat_session_skills` table with
`goat.chat_session_skill_bundles(chat_session_id, bundle_id, activated_message_id, source_kind)`.
The first activation of a skill name in a Chat fixes its bundle for that Chat.

Add `goat.chat_session_plugins(chat_session_id, plugin_id)`. The first coding turn captures the
currently enabled plugin IDs. Workflow Task creation stores skill bundle IDs and plugin IDs in the
Harness specification. Runners load only those immutable IDs. Disabling or archiving a plugin is a
live administrative kill switch, even for an existing snapshot.

### Durable plugin data

`goat.workspace_plugin_data` stores workspace ID, plugin name, private blob pathname, checksum,
size, generation, and a short runner lease. Before launching any server, the runner restores a
bounded tar archive to that plugin's writable `PLUGIN_DATA` directory. After every coding turn and
before a planned shutdown, it checkpoints the directory and updates the archive with a fenced
generation write.

Archive creation and extraction reject absolute paths, traversal, links, devices, and entries that
exceed the declared file or total-size limits.

The first release serializes MCP use of the same workspace/plugin data directory through that
lease. This avoids silent last-writer-wins corruption. If real usage shows the serialization is too
restrictive, per-session or mergeable storage can be designed from evidence later.

## Resolution rules

The catalog is the union of enabled standalone installations and skills from enabled plugins.
Resolution is deterministic:

1. a standalone skill wins over every plugin skill with the same name;
2. among plugin collisions, the lexically smaller plugin name wins; and
3. every hidden collision is included in the plugin install/report response and settings UI.

The bundle itself is not renamed. Mount directories always equal the skill's declared name.

## MCP security and runtime

Plugin installation and MCP approval are separate commands. The approval screen shows the plugin
source, resolved commit, integrity, server names, executable, arguments, working directory, and
declared environment variable names. It never renders secret values. Installing a replacement
package clears approval because its integrity differs.

For each approved stdio server, the runner creates a trusted launcher that:

1. verifies the materialized plugin root and requested working directory remain contained;
2. expands `PLUGIN_ROOT` and `PLUGIN_DATA` once in args, declared env values, and cwd;
3. resolves the executable to an absolute path;
4. starts from an empty environment and adds only a small runtime allowlist, the declared plugin
   environment, `PLUGIN_ROOT`, and `PLUGIN_DATA`; and
5. changes directory and uses `exec` without building a shell command string.

This launcher is required because ACP's stdio server schema has no cwd field and requires an
absolute command. Claude receives the launcher through `session/new.mcpServers`. Codex receives a
generated `[mcp_servers.*]` entry. Plugin MCP configuration participates in the Codex app-server
fingerprint so configuration changes restart the daemon instead of reusing stale state.

Runtime server names are namespaced as `<plugin-name>.<server-name>` to avoid cross-plugin MCP name
collisions. No runner, model, GitHub, repository, or process environment secrets are inherited by
plugin subprocesses.

## API and UI surface

### Standalone skills

- Preview a GitHub/skills.sh source.
- Install the selected strict skill with expected commit and integrity.
- List and inspect installed skills and file metadata.
- Read one authorized file in bounded chunks.
- Enable, disable, replace, or archive an installation.

There is no free-form skill editor. Authors produce a standard skill directory and import it.
Preview responses contain metadata and file names/sizes only; raw bundle bytes remain internal.

### Plugins

- Preview a source, manifest, discovered skills, stdio servers, and validation report.
- Install with expected commit and integrity.
- List and inspect plugins.
- Enable, disable, or archive a plugin.
- Approve or revoke MCP for the exact installed integrity.
- Delete persistent plugin data as a distinct destructive action.

The plugin detail screen clearly separates passive skills from executable MCP servers.

## Primary code areas

- Format parsing, resolution, raw file types, and integrity:
  `packages/agent-runtime/src/skill-resolver.ts`, new `skill-spec.ts`, `plugin-spec.ts`, and tests.
- Application contracts and authorization: `packages/core/src`, `packages/agent/src`, and
  `packages/protocol/src`.
- Storage and transactions: `packages/db/src/product-schema.ts`, repository modules, and new Drizzle
  migrations.
- HTTP DTOs: `apps/api/src/app.ts`; resolved raw bytes must not cross the public preview boundary.
- Main Chat disclosure: `packages/agent/src/skills.ts`, host-tool registration, and runner host-tool
  adapters.
- Sandbox mounts and MCP: `apps/runner/src/codex-managed-skills.ts`, `codex-chat.ts`,
  `claude-code-chat.ts`, `acp-harness.ts`, `codex-app-server.ts`, and new managed-plugin/data modules.
- Product UI: the current Skills settings routes and new Plugins settings routes under `apps/web`.

## Delivery sequence

Each phase is a reviewable vertical slice. Later phases depend on the earlier invariants; none adds
a temporary compatibility abstraction.

### Phase 0: remove the dormant public layer

- Record production row counts for `public.workspace_skills`,
  `public.workspace_skill_snapshots`, and `public.workspace_sync_jobs` before migration.
- Drop all three tables and remove their Drizzle definitions, relations, types, and stale comments.
- Delete runtime types that existed solely to describe those historical tables.

This is intentionally destructive. The row-count check documents impact; it is not a migration or
restore gate unless unexpected live ownership is discovered.

### Phase 1: implement the portable artifact core

- Replace `parseSkillFrontmatter` with one strict Agent Skills parser returning all six fields and
  the exact body boundary.
- Remove `command`, slug normalization, auto-suffixing, and opencompany-only description rules.
- Change resolver files to raw bytes plus executable bit.
- Reject truncated GitHub trees rather than accepting incomplete packages.
- Add the new integrity algorithm and bounded path helpers.
- Add a pure Agent Plugins 1.0.0 parser for `plugin.json`, `skills/`, and `mcp.json`; validate all
  official transports but select only stdio for execution.
- Cover every supported normative rule with table-driven fixtures.

Keep the existing GitHub tree/blob transport for the first release. Authentication, archive-based
fetching, and caching are operational optimizations to add only if rate-limit telemetry shows they
are needed.

### Phase 2: add immutable storage and cut over standalone skills

- Add the bundle, bundle-file, and installation tables.
- Add preview/install/list/read/enable/disable/replace/archive repository and API operations.
- Persist a resolved bundle and its installation atomically.
- Make name collisions return `409`; never rename a valid artifact.
- Replace the settings editor with import and read-only bundle inspection.
- Add chunked `read_skill_file` to Main Chat and its host-tool plumbing.

Do not expose bundle contents through preview DTOs. Validate workspace ownership on every bundle and
file read, and repeat path-containment validation in the runner even though stored paths are
validated on write.

### Phase 3: snapshot and mount exact skill bundles

- Add the new Chat bundle snapshot table and bundle-ID Harness fields.
- Snapshot a standalone or plugin skill's bundle ID on activation.
- Materialize every file byte-for-byte under `.agents/skills/<name>` for Codex and
  `.claude/skills/<name>` for Claude.
- Apply mode `0555` to executable files and `0444` to other files; make the managed parent
  non-writable to the sandbox user after reconciliation.
- Include raw bytes and executable modes in mount fingerprints.
- Remove generated `SKILL.md` materialization and all fallback paths.

Golden tests cover CRLF, UTF-8 BOM, no trailing newline, invalid UTF-8 binary data, executable
scripts, empty files, traversal attempts, and archive/replacement after snapshot.

### Phase 4: install plugins with skills

- Add plugin, plugin-file, plugin-skill, Chat plugin snapshot, and workspace plugin-data tables.
- Implement preview and transactional install of an immutable plugin package.
- Keep plugin skills separate and combine them through the documented resolution query.
- Snapshot enabled plugin IDs on the first coding turn and at Workflow Task creation.
- Materialize the complete plugin root read-only and expose its valid skills through the same bundle
  activation and mount paths as standalone skills.
- Mount every winning skill from a snapshotted enabled plugin into coding sandboxes; standalone
  skills remain explicit-activation only.
- Ship enable, disable, archive, collision reporting, and the plugin settings screens.

At the end of this phase opencompany is an Agent Plugins skills client. No plugin process executes.

### Phase 5: add approved stdio MCP and durable data

- Implement explicit integrity-bound MCP approval and revocation.
- Implement the trusted launcher, single-pass variable expansion, containment checks, sanitized
  environment, and namespaced server IDs.
- Restore and checkpoint `PLUGIN_DATA` through private blob storage with size caps, generation
  fencing, and the per-plugin lease.
- Thread MCP configuration through Claude ACP and Codex app-server configuration/fingerprinting.
- Surface server start, exit, invalid configuration, approval, data restore, and checkpoint failures
  without exposing environment values.

Do not claim MCP component support until this phase's conformance and secret-isolation tests pass.

### Phase 6: delete the current skill implementation

- Before deployment, report counts of current `goat.skills`, `goat.chat_session_skills`, and queued
  or running Workflow Tasks containing old `skillSnapshots`.
- Drop the old tables and delete old skill rows rather than converting them.
- Remove the hand-authored create/edit API, old import DTOs, serializer, compatibility validation,
  legacy workflow snapshot parser, slash-command extension, and old settings components.
- Regenerate OpenAPI and update current architecture, runner, environment, and user-facing docs.

Old Chat messages remain, but old skill activations no longer participate in replay. Old queued or
running Tasks that depend on legacy skill snapshots must be completed or canceled before this
cutover; the release preflight fails while any remain.

## Verification gates

Every phase runs focused unit and integration tests plus:

- `bun run format:check`
- `bun run lint`
- `bun run typecheck`
- `bun run test`
- `bun run build`
- `bun run secrets:check`

Required end-to-end scenarios:

1. Import a strict multi-file skill and prove stored and mounted bytes/modes equal the source.
2. Reject invalid names, directory mismatches, unknown frontmatter fields, traversal, symlinks,
   submodules, truncated trees, and size-limit violations.
3. Activate a skill in Main Chat, read a text file in chunks, and read a binary resource as base64.
4. Confirm an archived/replaced workspace skill does not change an existing Chat or Task snapshot.
5. Install a plugin with one valid and one invalid skill; install succeeds, only the valid skill is
   visible, and the report explains the skipped skill.
6. Confirm standalone-over-plugin and plugin-over-plugin collision resolution is deterministic.
7. Confirm installation alone never starts MCP; approval starts only the exact approved integrity.
8. Verify a plugin process cannot see model keys, GitHub credentials, runner environment, or other
   plugin data.
9. Write `PLUGIN_DATA`, replace the sandbox and plugin package, and verify the data is restored.
10. Disable or archive a plugin and verify its skills and MCP stop on the next turn, including in an
    existing snapshotted session.

## Explicit non-goals

- Legacy skill import, backfill, recovery, or lenient loading.
- Free-form in-product skill authoring.
- Plugin registries, dependency resolution, lockfiles, or arbitrary Git transports.
- Private repository installation in the first release.
- Streamable HTTP or SSE MCP.
- Main Chat MCP subprocesses.
- Plugin-defined hooks, commands, agents, UI, or opencompany extension semantics.
- Enforcing experimental Agent Skills `allowed-tools` declarations.
- Automatic plugin updates or background source polling.
- Cross-client mount-directory discovery beyond the Codex and Claude paths already used by the
  runner.

Anything in this list requires a concrete user need and a separate plan.
