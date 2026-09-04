# ADR 0006: Standard-First Plugins Through One Action Gateway

- Status: Accepted
- Date: 2026-09-01
- Standards: [Agent Plugins 1.0.0](https://agent-plugins.org/) and
  [Agent Skills](https://agentskills.io/specification) (loader shipped in
  [ADR 0005](./0005-agent-skills-and-plugins.md))

## Context

opencompany needs one integration surface for chat and coding sessions on every engine: tools
from external services, portable skills, human-labeled permissions, and connected accounts.
The prior model spread this across per-provider integration cards, engine-specific policies
(`cloudReadOnly`), and direct dispatchers, with no durable approval mechanics on external
engines.

## Decision

### The package is the only distribution format

Agent Plugins 1.0.0 packages — pinned commit, integrity hash, public GitHub sources — are the
sole container for a service's tools and skills. We author official plugins as standard
packages ourselves; no manifest dialect adapters, no marketplace or registry of our own, no
automatic updates (a plugin update is a supply-chain event and gets a click).

A plugin is the user-facing container for one service: Tools (MCP), Skills, Permissions,
Accounts. Curation travels in the package: official packages carry a
`so.opencompany.capabilities` extensions block (capability groups with label, default mode,
member tools), honored only for integrity-pinned packages from the trusted allowlist.
Third-party packages get the generic two-bucket scheme regardless of their extensions.

### One gateway on every engine

Every tool call from every engine passes the action gateway: one catalog, one permission
policy, one approval mechanic, one delegation-triple audit trail, one kill switch. Engines
differ only in transport (in-process vs ticket-authed HTTP MCP). Remote MCP servers from
plugin `mcp.json` entries are consumed server-side by the gateway as the MCP client; remote
server URLs and credentials never reach sandboxes, Main Chat, or plugin processes.

Capability modes stay `on | ask | off`: catalog drops `off` before the model sees it, `ask`
pauses into a durable approval record (hash-bound input, execute-time re-check), headless
surfaces auto-deny. Reads default `on`, writes and uncurated tools default `ask`; a vendor
`readOnlyHint` never upgrades a tool past `ask` on its own. The `cloudReadOnly` policy
divergence is deleted.

### Three planes, one owner each

- **Connection** — identity plane (`goat.integrations` + encrypted vault). Outlives installs,
  shared with ingestion. Install ≠ auth; uninstall removes tools and skills, never
  connections. MCP-dance tokens are audience-bound (RFC 8707) and cannot feed ingestion; each
  surface exposes exactly one connect concept and the credential duality stays inside the
  provider binding registry.
- **Capability** — permission unit; registry defaults plus sparse per-provider mode overrides
  that survive reinstalls.
- **Package** — the immutable installed artifact.

Plugin installs are workspace-scoped. At runtime actions bind to the acting user's connection,
falling back to a workspace-owned one. Long-lived credentials never reach model-visible
surfaces, plugin processes, or sandboxes; sandbox execution credentials are short-lived
provider-native tokens minted by the runner.

### Naming

Gateway sources are `plugin:<package>:<server>` — stable identifiers keying capability modes,
approval records, and built-in suppression. Account identity is a runtime binding rendered in
approval cards and transcripts, never part of the identifier.

## Consequences

Provider breadth is mechanical: author the standard package, add a provider binding registry
entry, delete the legacy integrations card in the same PR. The Linear vertical slice shipped
first (#1433); GitHub, Google, and Slack follow one PR each. Stdio plugin support stays frozen
in scope with no credential access under any future pressure. Deferred, re-addable: custom MCP
by URL, capability registry v2, resource-level narrowing, workspace minimum-mode policy,
upstream update tracking.
