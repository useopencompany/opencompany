# Plugins v2: standard-first, one gateway, one slice

- Status: Accepted — implementation target (supersedes the 2026-08-25 v1 of this doc)
- Date: 2026-08-26
- Standards: [Agent Plugins 1.0.0](https://agent-plugins.org/) and
  [Agent Skills](https://agentskills.io/specification) (loader shipped in
  [Agent Skills and Agent Plugins 1.0.0](./agent-skills-plugins.md))

## Summary

We go all-in on the Agent Plugins 1.0.0 standard: **the package is the only distribution
format**, for our official plugins and third-party ones alike, and we implement the standard as
a first-class client. Until vendors ship standard packages, **we author our official plugins as
standard packages ourselves** — we are the package vendor, not a dialect adapter.

A plugin is the user-facing container for one service: **Tools** (MCP), **Skills**,
**Permissions**, **Accounts**. Every tool reaches every engine through the one action gateway —
one catalog, one permission policy, one approval mechanic. Plugins never execute with
credentials; remote MCP servers are consumed server-side by the gateway.

On top of the standard we layer the two things it deliberately leaves to clients: our
**permission mapping** (human-labeled capabilities with `on | ask | off`) and our
**workspace-vs-personal ownership model**. That is composition, not deviation — the spec
excludes OAuth, credentials, and permissions from the manifest by design.

**Scope cut:** this doc covers making plugins available to the harness — Main Chat and coding
sessions on all engines. Wiki/brain ingestion, event triggering, and automation are out of
scope here. They impose exactly one constraint we must not break: **connections are shared and
outlive plugin installs** (ingestion reads the same `goat.integrations` rows). One related
guardrail for later: a token obtained through a vendor's MCP auth dance is audience-bound to
that MCP server (RFC 8707) and cannot feed REST polling or webhooks — ingestion requires
connections made through our own OAuth apps.

## What carries over from v1 (the invariants)

- **Three planes**, one owner and lifecycle each:
  - **Connection** — `goat.integrations` + encrypted tokens in `goat.integration_credentials`.
    Identity plane; outlives installs; shared with everything.
  - **Capability** — human-labeled permission unit with a mode; registry defaults + sparse
    `capability_modes` overrides, keyed by provider so modes survive reinstalls.
  - **Package** — the immutable installed artifact (`goat.plugins`, pinned commit + integrity).
- **Two invariants**, re-scoped to be true and stay true:
  1. **Long-lived credentials never reach model-visible surfaces, plugin processes, or
     sandboxes.** The backend (gateway dispatch) is the trust zone; the vault decrypts only
     there for model-initiated calls. Sandbox execution credentials are **short-lived,
     provider-native tokens** (e.g. per-turn GitHub App installation tokens), minted by the
     runner and logged — no separate broker system unless a second provider needs one.
  2. **Every credentialed call passes capability enforcement at call time.** Catalog drops
     `off` before the model sees it; `ask` pauses into approval; execute-time re-check closes
     the settings-flip race. Enforcement is code on the only path to the token.
- **Install ≠ auth.** Installing makes tools and skills available; connecting an account is a
  separate act on the plugin page. Uninstall removes tools and skills, never connections.
- **Delegation-triple logging**: the gateway stamps (acting agent, acting user, capability) on
  every credentialed call from day one.

## The standard boundary

| Layer | Owner | Contents |
| --- | --- | --- |
| **Package** (Agent Plugins 1.0.0) | Spec | Root `plugin.json` (`$schema` + `name`), `skills/` per Agent Skills, `mcp.json` (stdio + streamable-http/sse), `extensions` namespaces |
| **Host layer** | Us | Accounts/connections, capability permissions, tool enablement, install policy and limits, approval UX |

Client policy decisions, all spec-conformant:

- **Remote MCP entries become supported.** The loader currently validates `streamable-http` /
  `sse` entries and reports them unsupported; they flip to **registered with the gateway**,
  which consumes them server-side as the MCP client. Remote server URLs are never handed to
  sandboxes or Main Chat.
- **Stdio stays as shipped, frozen in scope.** The contained launcher (dedicated system user,
  empty env, integrity-bound approval, `PLUGIN_DATA` leases) keeps working; we build nothing
  more on it. Stdio processes receive no integration credentials — ever, under any feature
  pressure.
- **Curation travels in the package.** Official plugins carry their capability map in a
  reverse-domain extensions block (working name `so.opencompany.capabilities`; final key = our
  public domain): capability groups with label, default mode, and member tool names.
  **Definitions ship versioned with the package; user choices (modes) live in the DB keyed by
  provider.** Extensions are honored only in packages we authored and reviewed
  (integrity-pinned). Third-party packages get the generic scheme regardless of what their
  extensions claim.
- **Install sources** stay public GitHub + skills.sh with pinned commit + integrity, as
  shipped. No marketplace, no registry, no auto-updates.

## Architecture

```
Agent surfaces ── Main Chat (in-process) · Codex / Claude sandboxes (ticket-authed HTTP MCP)
      │                    one catalog · one policy · one approval mechanic
      ▼
ACTION GATEWAY ── catalog (drop off / annotate ask) · approval · execute re-check
      │             · turn governance · delegation-triple audit · kill switch
      ├─ first-party adapters (our OAuth apps: GitHub, Google, …)
      ├─ remote-MCP client (vendor + plugin mcp.json remote entries, server-side)
      └─ brokered (managed, account-less capabilities)
      ▼
STATE ── token vault (AES-GCM + AAD) · connections · capability modes
      ▼
CONSENT ── our OAuth apps · MCP auth dance (CIMD preferred, DCR fallback) · API keys

(parallel, credential-free: plugin skills mounted on all engines; frozen stdio runtime)
```

Engines differ only in **transport** (in-process vs the existing ticket-authed
`/internal/goat/acp-tools` route); the catalog, permission policy, and approval semantics are
identical. The `cloudReadOnly` policy divergence is deleted: external engines get the full
catalog, with `ask` enforced at the gateway. The likely mechanism for pausing an external-engine
turn on `ask` is ACP's `session/request_permission`; the exact mechanics are a deferred design
detail, not an architectural fork — if blocking at the MCP layer turns out to be needed instead,
it changes nothing above the gateway. Headless surfaces (Slack bot) auto-deny `ask` until they
grow an approval affordance.

## Permissions (our layer)

- **Registry v2 is deferred.** The four generic capability ids (`read`/`query`/`draft`/`write`)
  with per-provider labels are enough for the current providers; provider-scoped rich ids wait
  until a provider actually needs finer groups. No `capability_modes` key migration.
- Modes stay `on | off | ask`, stored as today. Defaults: reads `on`, writes `ask`, every
  uncurated tool `ask`; a vendor `readOnlyHint` may suggest the read bucket but never upgrades
  a tool past `ask` on its own.
- Uncurated packages and servers get two buckets — "Read tools" and "Write & other tools" —
  plus a per-tool advanced view for promoting individual tools.
- Never show a raw OAuth scope; the vendor's own consent screen is the one unavoidable
  exception.

## Ownership (our layer)

- Plugin installs are **workspace-scoped** (shipped). Connections keep the shipped derivation:
  `workspace_id IS NULL` = personal; the existing partial unique indexes enforce
  single-instance workspace providers.
- At runtime a plugin's actions bind to the **acting user's** connection for the provider,
  falling back to a workspace-owned one.
- Sharing a personal connection with the workspace grants **read capabilities only** — writes
  through someone else's identity are impersonation; members who write connect their own
  account. (The `shared_with_workspace` column exists; the rule lands with the sharing UI.)
- Workspace-owned connections (GitHub App, `slack_bot`, Stripe) are admin-administered;
  `ask` approvals go to the acting user in-chat.

## Build plan: one vertical slice, then mechanical breadth

### The slice — Linear, end to end

Linear is the first and only provider until the slice is done: its OAuth-to-vault MCP
connection, its `read`/`write` capabilities, its curated remote-tool map, and its ingestion all
exist already, so the slice is assembly, not invention.

1. **Gateway `ask` on all engines.** Approval enforced at the gateway/acp-tools layer; durable
   approval record; the existing approval card wired to gateway-originated events; delete
   `cloudReadOnly`; collapse the direct dispatchers (tasks, Slack bot) onto the gateway path.
2. **Remote-MCP adapter.** Generalize the existing remote-MCP machinery into a gateway adapter
   type: `tools/list` discovery, curated classification, unmapped → `ask`.
3. **The Linear plugin package.** Root `plugin.json`, 2–3 skills, `mcp.json` remote entry,
   `so.opencompany.capabilities` extension seeded from the existing curated action map.
   Installed through the shipped loader; remote entry registers with the gateway.
4. **Plugins page v1, one card.** Header + Install/Uninstall + View Source; Accounts (existing
   integration rows, multi-account works today); Tools (from discovery, grouped by capability
   with mode toggles); Skills.

**Acceptance demo (the gate for everything):** in a Claude Code session, "find my open Linear
issues" runs silently (read, `on`); "create an issue for this bug" pauses with an approval card
in chat, approve → created. Same behavior in Main Chat and Codex. Uninstall the plugin → tools
and skills disappear, Linear ingestion keeps flowing; reinstall → no re-OAuth.

### Breadth — one provider per PR, delete as we go

Each migration: author the standard package + capability labels + (curated map or first-party
adapter binding), delete the provider's card from the old Integrations tab in the same PR. The
two tabs coexist only while migrations are in flight.

Order by what each provider proves: **GitHub** second (the first-party adapter slot, and the
switch to per-turn installation tokens in sandboxes — closing today's raw `GH_TOKEN` exception);
**Gmail / Google Calendar** third (multi-capability consumer scale); **Slack** last — its
frictions (host-specific manifests in the vendor repo, scope gating of clients, workspace-admin
approval on its hosted MCP app) are vendor problems that must not block the architecture.
Managed capabilities re-front as account-less plugin cards whenever convenient. Custom MCP by
URL falls out of the adapter (connect via CIMD/PKCE or API key into the same vault, generic
two-bucket permissions, marked custom with the server URL visible) and ships when we want it,
not on the critical path.

### Deferred (re-addable, in likely order of need)

Custom MCP by URL · capability registry v2 · resource-level narrowing UX · workspace
minimum-mode policy · upstream update tracking · MCP Apps "Views" rendering · agent-native
identity on the delegation-triple trail · a credential broker system.

### Deliberately not building

- A plugin marketplace or registry of our own; forks or re-hosting of vendor packages.
- A manifest dialect adapter for `.claude-plugin/` / `.cursor-plugin/` repos — vendors adopt
  the standard or we author the package.
- Automatic background plugin updates (a plugin update is a supply-chain event and gets a
  click).
- Raw-scope UI or scope-per-toggle re-consent.
- A separate ingestion connection system — one identity plane, already shared.
- Credential access for plugin processes, under any future feature pressure.

## Risks

- **`ask` mechanics on external engines** (deferred by decision): ACP `session/request_permission`
  is the expected path; if CLI/MCP client timeouts force an approval-pending/poll shape
  instead, the change is contained to the acp-tools layer. Watch the runner lease during
  approval waits — a parked turn must keep heart-beating or recovery will reclaim it.
- **Vendor MCP variability**: tool lists change under us; discovery diffs surface new tools as
  unmapped → `ask` until classified. Misclassification is dangerous only write-as-read;
  maps live in code review.
- **Standard adoption pace**: Agent Plugins 1.0 is weeks old and Anthropic is not a maintainer;
  authoring our own packages insulates us either way, and any future vendor package that is
  standard-compliant loads with zero work.
- **Auth spec drift**: MCP 2026-07-28 deprecates DCR in favor of CIMD and removes sessions;
  verify our MCP auth dependency supports CIMD before the custom-by-URL milestone.
