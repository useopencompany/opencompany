# ADR 0013: Tool-Level Permission Overrides

- Status: Accepted
- Date: 2026-09-14
- Extends: [ADR 0006](./0006-gateway-plugins-and-integrations.md)

## Context

ADR 0006 gave every plugin connection a set of capability groups — `read`, `query`, `draft`,
`write` — each set to `on`, `ask`, or `off`. The group is the right default unit. Most people want
"let it read my Gmail" without reading seventeen tool descriptions, and a per-tool-only model would
make that common case expensive to express.

Being the *only* unit is what broke down.

Gmail's `write` group holds nine tools. Seven are label operations; `trash_thread` and
`trash_message` are not. A user either puts all nine on Ask and approves label writes several times
a day, or accepts automatic trashing. There is no way to say the obvious thing: *organize freely,
but ask before you trash.*

Worse, chat's `Always allow` resolved the approved action's capability and turned the whole group
on. Approving "label this thread" once also granted automatic `trash_thread` forever. That is a
consent defect, not an ergonomics complaint: the user agreed to one visible operation and was
charged for eight more they never saw.

The enforcement layer for the fix was already built and unreachable. `integrations.tool_modes` has
existed as a jsonb column alongside `capability_modes`, and `effectiveRemoteMcpMode` already
resolves a per-tool override ahead of the capability group, on both the catalog path and the
re-check before a call. Every plugin's per-call authorizer already consults it. Only custom MCP
servers could write a key, because only their settings surface offered one — which is also why
`alwaysAllowAction` had to refuse custom MCP with "Set standing permissions for individual custom
MCP tools in Plugins." Two permission models lived in one settings page.

## Decision

**The capability group stays the control. An individual tool is an exception to it.**

Every tool inherits its group. A user who never opens the tool list sees and does exactly what they
did before. Resolution is one rule, unchanged from what the gateway already implemented:

```
effective = tool override ?? group mode
```

An explicit tool setting wins in both directions: it can be stricter than an `on` group or looser
than an `off` one. Overrides are stored sparsely in `integrations.tool_modes`, keyed by the raw MCP
tool name, so an untouched connection stores exactly what it stored before and no migration was
needed.

Inheritance, rather than a group toggle that bulk-writes every tool, is what makes this survive
discovery: MCP servers add tools, and an inherited tool picks up its group's mode automatically
instead of landing unset. The uncurated rule the gateway already enforced is preserved and now
surfaced — a newly discovered, unclassified tool holds at Ask even under an `on` group, because it
must not inherit a broad grant, while an explicit override still applies.

Only "use the group" releases a tool. Pinning a tool to the mode it currently inherits still counts
as an exception, so a later group change cannot quietly undo the decision. "Custom" therefore means
*set by hand*, not *differs from its group*.

### Chat approval

A standing permission is now saved as narrowly as the action allows. Plugin actions are each one
discovered MCP tool, so `Always allow this tool` writes that tool's key and nothing else. Native
actions have no tool key and still save against their capability, as before. The custom-MCP
refusal now guards only the capability-wide branch, which custom MCP tools no longer reach — both
plugin kinds finally support per-tool standing permissions.

The card deliberately keeps **one** approving button. A second "widen the whole group" button was
designed and dropped: the approval payload is the model's own `{ action, params }` and the
capability label lives in the discovery snapshot, so that button could only have read "Always allow
this capability" — asking the user to widen something the card cannot name, which is the exact
defect this ADR removes. Group-wide changes belong in settings, where the group is named and its
tools are listed.

## Consequences

- Plugin settings and custom MCP settings render tools through one component. A custom server has
  no capability group, so its inherit option reads `Default (Ask)`.
- Tool rows mount lazily when a group is opened, since each row now carries a select. A group with
  hundreds of discovered tools costs nothing until it is expanded.
- The settings resolver (`effectiveToolMode`) and the gateway resolver (`effectiveRemoteMcpMode`)
  are now two implementations of one rule, including the uncurated case. They must agree; if they
  drift, settings will describe behavior the gateway does not implement.
- An override outlives the memory of setting it. Overrides live on the durable connection, so an
  `off` survives a package archive and reinstall — deliberate, and the reason the group card
  surfaces a `N custom` badge and a one-click reset rather than hiding exceptions behind a
  disclosure.
- Workspace-level policy — an admin pinning a tool for everyone — is out of scope and should not be
  layered onto the same per-connection key.
- The Infisical docs plugin still reports no configurable modes: its documentation reads are fixed
  On and its feedback tool fixed Off.
- The design prototype that preceded this (`/internal/prototypes/tool-permissions`) is removed. It
  modelled storage that the shipped version does not use, so keeping a second, diverging
  implementation of the same screen would have been a standing source of wrong answers.
