# Tool-level permission overrides

Status: proposal · Prototype: `/internal/prototypes/tool-permissions` (signed-in route, nothing is
persisted)

## The problem

Plugin permissions are set on a capability group — `read`, `query`, `draft`, `write` — and each
group is `On`, `Ask`, or `Off`
(`packages/agent/src/actions/capabilities.ts`). A group is the right default unit: most people want
"let it read my Gmail" without reading 17 tool descriptions. But the group is currently the *only*
unit, which produces three concrete failures:

1. **One dangerous tool poisons a useful group.** Gmail's `write` group ("Organize Gmail") holds 9
   tools. Eight are harmless label operations. `trash_thread` and `trash_message` are not. Today the
   user either puts all nine on Ask, or accepts nine automatic writes. Most people pick Ask and then
   click approve nine times a day for label changes.
2. **"Always allow" in chat silently widens everything.** `alwaysAllowAction`
   (`apps/runner/src/action-permissions.ts`) resolves the action's capability and calls
   `applyIntegrationCapabilityMode(..., mode: "on")` for the whole group. Approving "label this
   thread" forever also grants automatic `trash_thread`. That is a consent problem, not just an
   ergonomics one.
3. **Custom MCP plugins are already per-tool, official plugins are not.** `CustomMcpRepository`
   stores `toolModes: Record<string, "on" | "ask" | "off">`, and `alwaysAllowAction` has to bail out
   with "Set standing permissions for individual custom MCP tools in Plugins." Two permission models
   in one settings surface.

## The principle

**The group stays the control. Individual tools are exceptions.**

Every tool inherits its group. A user who never opens the tool list sees and does exactly what they
do today. A user with a specific worry sets one tool and moves on. Nobody is asked to configure 17
things.

This is deliberately *not* "expose a toggle per tool". A flat per-tool list is a worse product for
the same reason a flat permission list is worse in iOS or GitHub: the common case becomes expensive
to express, and newly discovered tools have no defined state.

### Why inheritance, not bulk-apply

The obvious cheaper alternative is to make the group toggle a bulk setter — it writes its value onto
every tool and inheritance does not exist. Rejected: MCP servers add tools. When Gmail's package
gains an 18th read tool, inheritance gives it the group's mode automatically, while a bulk-setter
model leaves it undefined and forces the user back into settings. Inheritance also keeps storage
sparse — only the exceptions are written — so an untouched connection stores nothing new.

## The model

Per tool, four states:

| State | Meaning |
| --- | --- |
| `inherit` (default) | Use the group's mode. Not stored. |
| `on` | Runs without asking, even if the group is Ask or Off. |
| `ask` | Always asks, even if the group is On. |
| `off` | Hidden from the agent, even if the group is On. |

Resolution is one line: `effective = override ?? groupMode`. The explicit tool setting wins, in both
directions. That is the only rule a user has to hold, and it matches how people already read
specific-beats-general settings.

Setting a tool to the value it already inherits is normalized back to `inherit`, so a "custom"
marker never lies.

### Storage

Tool overrides live beside the group modes in the existing
`integrations.capability_modes` jsonb, under a `tools` key. Capability ids are a closed set
(`read | query | draft | write`), so the key cannot collide, and `isCapabilityId` already guards
every existing read path.

```json
{
  "query": "on",
  "write": "ask",
  "tools": { "gmail:trash_thread": "off", "gmail:create_label": "on" }
}
```

Keys are the discovered tool id `${server.name}:${tool.name}` — the id
`officialPluginToolsStateFromPlugin` already builds. No migration: absent `tools` means no
exceptions, which is today's behavior.

## The UX

### Settings

The group card is unchanged: label, description, and the `On / Ask / Off` pill. Everything new lives
inside the existing "N tools" disclosure, which is collapsed by default.

- Each tool row gains a small select on the right. Inherited rows render the **effective** mode in
  muted text; overridden rows render it in full ink with a dot. The column stays scannable — you can
  read a group's real behavior top to bottom — while the two rows that differ are obvious.
- The select offers `Use group (Ask)`, `On`, `Ask`, `Off`. The inherit option names the value it
  will apply, so choosing it is never a guess.
- When a group has exceptions, the disclosure summary reads `9 tools · 2 custom` and the card shows
  a `2 custom` badge, so exceptions are discoverable without expanding anything.
- Changing the group toggle **does not** clear exceptions. Instead an inline line appears under the
  group: `2 tools keep their own setting · Reset`. Silently discarding a user's explicit decision is
  worse than one extra line of text, and the reset is one click.

### Chat approval

The approval card's single `Always allow` becomes two intents:

- **Always allow this tool** — writes `tools[toolId] = "on"`. The default, and what people actually
  mean.
- **Allow all "Organize Gmail"** — today's behavior, still one click, now labeled with what it
  grants.

Three approving buttons is the most the card should ever carry; at the chat column's width they
still fit on one row, but if a future card needs a fourth, the group-wide grant is the one to move
behind a menu.

This is the highest-value half of the change and it costs nothing once overrides exist:
`alwaysAllowAction` writes one key instead of a group mode, and the custom-MCP special case in that
function disappears because both plugin kinds now support per-tool standing permissions.

## Implementation plan

1. **Model** (`packages/agent/src/actions/capabilities.ts`): add `toolOverride` parsing and
   `effectiveToolMode(provider, capabilityId, toolId, stored)`. Pure, client-safe, unit tested next
   to the existing `effectiveCapabilityMode` tests.
2. **Persistence** (`packages/db/src/integrations.ts`): `applyIntegrationToolMode({ integrationIds,
   toolId, mode })`, writing/removing the sparse `tools` key. No schema migration.
3. **API** (`apps/api/src/integration-accounts.ts`, `packages/protocol/src/routes.ts`): a
   `PUT /v1/integration-accounts/:integrationId/tool-modes/:toolId` sibling of the capability-mode
   route, with the same authorization and validation.
4. **Enforcement**: gate at the point that already reads the capability mode — the MCP tool list and
   the per-call authorizer in each official server (`gmail-mcp-server.ts` and peers go through the
   shared classification), plus `projectActionCatalog` for native actions. An `off` tool is removed
   from the catalog; an `ask` tool forces approval.
5. **Chat approval** (`apps/runner/src/action-permissions.ts`, `apps/web/components/chat/ToolCallItem.tsx`):
   split `Always allow` into the two intents above; drop the custom-MCP rejection branch.
6. **Settings UI** (`apps/web/components/OfficialMcpPluginSettings.tsx`): `ToolRows` gains the
   select, the group card gains the badge and the reset line.
7. **Unify custom MCP**: render custom MCP tools through the same row component. Their existing
   `toolModes` map is the same shape, so this is presentation-only.

Steps 1–3 are independently shippable and inert until step 4.

## Open questions

- Should a tool override survive the plugin being uninstalled and reinstalled? Capability modes do,
  because they live on the integration row. Tool ids are stable across reinstall, so overrides
  would too — that seems right, but it means an `off` can outlive the user's memory of setting it.
- Workspace-level policy (an admin pinning a tool to `off` for everyone) is out of scope here and
  should not be bolted onto the same key.
