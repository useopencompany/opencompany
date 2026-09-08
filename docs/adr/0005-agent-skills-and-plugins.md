# ADR 0005: Immutable Agent Skills and Agent Plugins

- Status: Accepted
- Date: 2026-08-21
- Standards:
  [Agent Skills](https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx) and
  [Agent Plugins 1.0.0](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md)

## Context

opencompany needs portable Agent Skills, Plugin-provided Skills, and optional MCP servers without
allowing mutable workspace configuration to change an existing Chat or Task. Installation must not
implicitly grant process execution, and coding sandboxes must not inherit product credentials.

The former model stored editable, opencompany-specific Skill content and replayed historical
activations. That contract was incompatible with strict portable bundles and deterministic durable
execution.

## Decision

### Immutable artifacts and snapshots

Agent Skills are validated against the standard frontmatter contract and stored as complete,
immutable file bundles. Agent Plugins are stored as immutable packages with a validated manifest,
valid immediate-child Skills, source provenance, resolved commit, integrity, and install report.

Chats and Tasks capture immutable bundle and Plugin IDs, never a mutable name lookup. Replacing an
installation creates a new artifact and moves the live installation pointer; existing durable work
continues to use its captured version. Archived artifacts remain available while referenced.

### Strict validation and bounded sources

The first release accepts supported public GitHub and skills.sh sources. It rejects unsafe paths,
symlinks, submodules, traversal, oversized packages, and invalid Skill frontmatter. Invalid Plugin
manifests reject the package. Invalid child Skills are skipped and reported at the Plugin boundary.

The catalog resolves name collisions deterministically: a standalone Skill wins over Plugin Skills,
then the alphabetically earlier Plugin name wins. Hidden collisions remain visible in the install
report and settings UI.

### MCP requires separate approval

Installing or enabling a Plugin never starts a process. An admin must approve the exact installed
Plugin integrity before stdio MCP servers can run. Replacing the Plugin clears that approval. The
approval UI shows commands, arguments, working directories, and declared environment variable
names, but never secret values.

MCP processes run only in Codex and Claude coding sandboxes. Main Chat consumes passive Skills but
does not launch Plugin processes. The initial runtime supports stdio MCP only; HTTP and SSE entries
are recognized as unsupported.

The launcher resolves contained paths, expands only `PLUGIN_ROOT` and `PLUGIN_DATA`, uses an empty
base environment plus a narrow runtime allowlist and declared variables, and executes without
constructing a shell command. Runtime server names are namespaced by Plugin.

### Durable Plugin data

Each Plugin receives a writable `PLUGIN_DATA` directory. The runner restores and checkpoints a
bounded private archive keyed by workspace and Plugin name so data survives sandbox and Plugin
replacement. Archive extraction rejects traversal, links, devices, and size-limit violations.
Concurrent use is fenced to avoid silent last-writer-wins corruption.

### Clean legacy cutover

The editable legacy Skill model, custom `command` frontmatter, compatibility parsing, historical
activation replay, and dormant workspace Skill tables are not migration inputs. Historical Chat
messages remain readable, but old activations are not executable and were not converted into new
bundles.

## Consequences

- Durable work is reproducible even when workspace installations change.
- Plugin installation and code execution have distinct, reviewable trust boundaries.
- Sandboxes receive only declared Plugin configuration and no ambient product secrets.
- Package replacement preserves Plugin data but requires renewed MCP approval.
- Supporting more sources, transports, or dependency resolution requires a later decision rather
  than compatibility behavior in the portable core.
