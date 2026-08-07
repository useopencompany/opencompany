# Goat Plugins — Aligning Skills & Integrations with the Agent Plugins Standard

Status: decisions made (2026-08-07), ready for implementation planning. Scope is `apps/goat`
only — `apps/web`'s skill/tool/integration system is a separate, legacy product surface and is
out of scope here.

Research background: this proposal follows a UX-first research pass comparing our current
Goat architecture against **Agent Plugins v1.0.0** (agent-plugins.org, published 2026-08-06 by
OpenAI, AWS, Cursor, Microsoft/VS Code, Vercel — launch clients ChatGPT, Codex, Cursor, GitHub
Copilot, Kiro, VS Code). See [Incremental Capability Discovery](./incremental-capability-discovery-research.md)
for the closest prior art in this repo (written for the `/personal` experiment, not Goat, but
the same underlying gap: users have no live way to discover capabilities they haven't enabled).

---

## 1. What the standard actually says

Agent Plugins is a **packaging format**, not a runtime. A plugin is a directory:

```
plugin-name/
├── plugin.json          # manifest: name, version, description, author, ...
├── skills/               # optional — each subfolder a SKILL.md (Agent Skills spec)
│   └── my-skill/SKILL.md
└── mcp.json              # optional — MCP server configs (stdio / streamable-http / sse)
```

Two load-bearing decisions for us:

- **Skills and MCP load independently.** A plugin can be instructions-only, actions-only, or
  both. There's no requirement to pair them.
- **v1 defines no permission model, no consent flow, no sandboxing, no secrets mechanism.**
  That's explicitly left to each client. There is no "standard UX" to copy here — the
  packaging is solved industry-wide, the trust/consent experience is entirely ours to design,
  and it's the part users will actually judge us on.

## 2. Where Goat stands today

### Skills — closer to spec-compliant than expected

`goatSkills` (`packages/db/src/goat-schema.ts:2701`) is a first-class table: `slug`, `name`,
`description`, `instructions` (plain text), `status: draft|active`, workspace-scoped. Authored
in-app via `/settings/skills` (`apps/goat/app/(app)/settings/skills/[slug]/page.tsx`), attached
to a chat turn with `@skill/<slug>`, and immutably snapshotted into `goatChatSessionSkills` for
that session (`apps/goat/lib/skills.ts:233`).

The interesting part: `serializeGoatBrainSkillMarkdown` (`packages/goat-brain/src/skills.ts:47`)
already emits real `SKILL.md`-shaped output — YAML frontmatter (`name`, `description`) plus a
markdown body — with a comment noting *"native skill runtimes use the frontmatter name as the
invocation id."* Goat skills are conceptually Agent Skills already; they're just: (a) not stored
as files, (b) not importable from an external source, (c) instructions-only — no bundled
`scripts/` or `references/` the way `apps/web`'s external-skill materialization supports
(`skills-implementation.md`).

`apps/web` already solved external-skill import once: `packages/agent-runtime/src/skill-resolver.ts`
parses a GitHub/skills.sh URL, discovers `SKILL.md`, validates, hashes, and snapshots it. That
resolver is directly reusable for Goat rather than a new build.

### Integrations — bespoke first-party APIs, not MCP, today

`goatIntegrations` (`packages/db/src/goat-schema.ts:1437`) is a hardcoded enum of 17 providers
(gmail, slack, linear, github, hubspot, stripe, ...), each with its own OAuth flow, `status`,
and a `capabilityModes` map (`Partial<Record<string, "on"|"off"|"ask">>`) — a **per-capability,
per-connection consent toggle** that's genuinely ahead of what the open standard or most
competitors ship. `SettingsIntegrationsPanel.tsx` renders these under a Workspace/Personal
scope switch, where scope is derived from whether the credential is identity-bound (personal)
or installation-bound (workspace) (`packages/db/src/goat-schema.ts:1441-1455`).

Two things worth knowing before scoping "align with the standard" work:

1. **Goat is an MCP *server*, not a client, in its shipped code path.** `apps/goat/lib/mcp-server.ts`
   exposes Goat's own Brain tools *to* external clients (Claude, ChatGPT, Cursor connecting in).
   The agent's own chat/task loop does not consume third-party MCP servers as a client today —
   integrations are bespoke REST API calls, not `mcp.json`-style connections.
2. **The MCP-client machinery already exists, unwired.** `apps/runner/src/goat-remote-mcp-tools.ts`
   (`createGoatRemoteMcpTools`) is a generic, parameterized factory — give it a provider id, a
   remote endpoint URL, and OAuth wiring, and it produces `{provider}_search_tools` /
   `{provider}_use_tool` runtime tools exactly like `apps/web`'s MCP lane. As of this writing it
   has **zero production callers** (only its own test imports it) — it's a built foundation, not
   yet product surface. This is the single biggest unlock for "align integrations with the
   standard's `mcp.json` half": generalizing this factory to read connection config dynamically
   (instead of one hardcoded file per provider) gets us most of the way to consuming arbitrary
   MCP servers without new low-level plumbing.

### The gap vs the standard, concretely

| Spec concept | Goat today |
|---|---|
| `skills/*/SKILL.md` | Workspace-authored only, DB-backed, no external import, no `scripts/`/`references/` |
| `mcp.json` (arbitrary remote MCP servers) | No generic client path; 17 hardcoded first-party integrations, each bespoke REST, not MCP |
| `plugin.json` bundling both | No concept of a "plugin" — skills and integrations are unrelated settings pages with unrelated data models |
| Client-managed consent (spec's open question) | **Already have an answer**: per-capability On/Ask/Off (`capabilityModes`) — worth generalizing, not replacing |

## 3. Proposed model

### 3.1 Keep two user-facing nouns, not three

Users think in two categories, and conflating them is a trust mistake (a "skill" install should
never silently grant real account access):

- **Skill** — instructions. Free, no real-world access, no consent step.
- **Integration** — an actual connection to a real account/system. Always a consent step, always
  visible in Settings, always revocable.

**Do not introduce "Plugin" as a third user-facing word or nav item.** Internally, a *plugin* is
the packaging unit (skill + optional integration/MCP config shipped together) — that's a
developer/import-flow concept, not something a founder needs to see or understand. This mirrors
how ChatGPT names things "Apps" and "Skills"-adjacent internal names never surface, rather than
Cursor's dev-facing "Plugins" marketplace vocabulary — closer fit for our audience (2-10 person
teams, not developers customizing an IDE).

### 3.2 One import mechanism behind both surfaces

Extend Goat's existing `/settings/skills` "Create skill" flow with a second entry point,
**"Import from a link"**, that accepts a GitHub URL pointing at either a bare `SKILL.md` (today's
`apps/web` case) or a full Agent Plugin directory (`plugin.json` + `skills/` + `mcp.json`):

- Reuses `packages/agent-runtime/src/skill-resolver.ts` for the skill half.
- If `mcp.json` is present, generalizes `createGoatRemoteMcpTools` to read `{ endpointUrl, displayName, authScope }` from the manifest instead of a hardcoded config, and creates a generic `goatIntegrations` row (`provider: "mcp"`, with endpoint/display data on the row rather than a new enum value per plugin — decision 2 below) pointing at that endpoint.
- The import preview shows **both halves separately** before confirming: "This adds the skill '{name}'" and, if present, "This also wants to connect to {endpoint} — you'll be asked to authorize it separately." Skill import completes immediately; integration connection always drops into the normal OAuth/consent flow, never auto-grants.

### 3.3 Generalize the consent model, don't replace it

Goat's `capabilityModes` (On/Ask/Off per capability per connection) already exceeds what the
spec asks for. Apply the same three-state model uniformly to actions that arrive via an
imported MCP-backed integration, not just the 17 first-party ones — so a plugin's actions show
up in Settings with the identical toggle UX a user already understands from Linear/Slack/Gmail.

### 3.4 Discovery stays proactive, not just a catalog page

Per [Incremental Capability Discovery](./incremental-capability-discovery-research.md): the
higher-value UX than a browsable directory is the agent noticing mid-task that a skill or
integration would help and proposing it in-chat ("I could do this if you connected Notion —
want me to?"). A Settings-page catalog is still needed as the durable "inventory + shop," but
it shouldn't be the primary discovery path for this audience.

## 4. Decisions

1. **Import trust model: admin-curated allowlist at launch, but architected for BYO-MCP later.**
   Arbitrary remote MCP servers execute real code paths against real user accounts, and the spec
   itself has no signing/sandboxing/secrets story yet — not something to inherit blind. We vet
   and enable plugins ourselves for V1/V2 (matches "fewer things really well"). But the gating
   must live in policy/data, not in the runtime or schema, so opening it up later (an admin
   pastes an arbitrary MCP URL) is additive, not a rearchitecture. This directly motivates
   decision 2.
2. **Provider modeling: generic `provider: "mcp"` row, not one enum value per plugin.**
   `createGoatRemoteMcpTools` already takes plain config (`endpointUrl`, `authScope`, ...) —
   nothing to change there. The actual hardcoding is `goatIntegrations.provider`, a fixed
   Postgres `CHECK` enum. If every new vetted plugin became a new enum value, we'd still be one
   migration away from BYO-MCP the day we want it. Instead: a single generic MCP-integration row
   shape where the specific server is *data* (name, endpoint, auth config), not schema. Launch
   curation becomes an application-layer allowlist (which endpoints we seed / show in the
   picker), trivially relaxed later with zero migration. The 17 existing bespoke-REST
   integrations (Gmail, Slack API, etc.) are untouched — this only applies to the new MCP lane.
3. **Imported skills: read-only, no fork/duplicate action in V1.** Matches `apps/web`'s
   external-skill precedent and avoids silent drift from what the author published. Explicitly
   *not* building "duplicate to make an editable copy" now — defer until a user actually asks
   for it, same principle as decision 5 below. The existing "create skill from scratch" authoring
   flow is untouched and stays available in parallel; importing and hand-authoring are just two
   entry points into the same `goatSkills` table.
4. **Scope: workspace-wide only, no personal skills in V1.** An imported plugin is enabled at the
   workspace level by an admin (new gate that doesn't exist yet — today's first-party
   integrations have no such admin-enable step); the actual connection underneath still follows
   the existing identity-bound-vs-installation-bound split per credential. Personal (per-user,
   not workspace-visible) skills were considered and explicitly deferred: `goatSkills` has no
   owner concept today, and adding one means a schema change *and* updates to two independent
   mention-resolution paths (main chat composer via `resolveGoatSkillMentions`, and Workflow
   instructions via `extractGoatWorkflowSkillMentionRefs` in `apps/goat/lib/workflow-tasks.ts`) —
   real, doable work, but no signal yet that anyone wants private-to-me skills over workspace
   ones. Leaving the owner-column shape open (same identity-bound pattern `goatIntegrations`
   already proves out) so adding it later is additive.
5. **Discovery: ship the one-line system-prompt nudge in V1**, paired with the Settings-page
   import rather than waiting for V2's fuller allowlist. Cache-stable, ~1 line (direction C from
   [Incremental Capability Discovery](./incremental-capability-discovery-research.md)): tell the
   agent to check what's available before assuming it can't do something. Cheap enough to ship
   even against a small V1 catalog.

## 5. Phasing

**V1 (skills spec-alignment + the discovery nudge, no new trust surface):**
- Rename nothing in the nav; keep Skills and Integrations as separate settings pages.
- Add SKILL.md import (bare skill only, no `mcp.json`) to `/settings/skills`, reusing
  `packages/agent-runtime/src/skill-resolver.ts`. Imported skills are read-only, no fork action.
- Add the one-line discovery nudge to the system prompt.
- No change to integrations yet — this alone gets skills to real spec compliance.

**V2 (the actual "integrations align with the standard" work):**
- Introduce the generic `provider: "mcp"` integration row shape (decision 2).
- Generalize `createGoatRemoteMcpTools` to be config-driven off that row; wire it into the
  integration connect flow for a small **admin-curated allowlist** of MCP-backed plugins
  (decision 1) — admin enables a plugin workspace-wide, then per-person connection follows the
  existing identity-bound pattern (decision 4).
- Full plugin bundle import (`plugin.json` with both halves) once the allowlist model is proven.

**V3 (only if justified by demand):**
- `scripts/`/`references/` support in skills (requires sandboxed materialization, currently only
  built for `apps/web`'s runner — real engineering lift, not a UX decision).
- Fork/duplicate-to-edit for imported skills (decision 3).
- Personal (non-workspace-wide) skills (decision 4).
- Open, non-curated third-party plugin import / admin-pasted MCP URLs (decision 1).

Ready for an implementation plan against V1 whenever you want to move to that.
