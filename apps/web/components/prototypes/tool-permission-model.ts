import type { CapabilityId, CapabilityMode } from "@/lib/actions/capabilities";

/**
 * The proposed per-tool state. `inherit` is the default and is never stored, so an untouched
 * connection keeps exactly today's payload. See docs/future-concepts/tool-level-permissions.md.
 */
export type ToolMode = CapabilityMode | "inherit";

export type PrototypeTool = {
  /** `${server.name}:${tool.name}` — the id officialPluginToolsStateFromPlugin already builds. */
  id: string;
  name: string;
  description: string;
};

export type PrototypeGroup = {
  id: CapabilityId;
  label: string;
  description: string;
  defaultMode: CapabilityMode;
  tools: PrototypeTool[];
};

/** What a connection would persist in integrations.capability_modes under this proposal. */
export type PrototypeState = {
  groups: Partial<Record<CapabilityId, CapabilityMode>>;
  tools: Record<string, CapabilityMode>;
};

export function groupMode(state: PrototypeState, group: PrototypeGroup): CapabilityMode {
  return state.groups[group.id] ?? group.defaultMode;
}

/** The whole resolution rule: an explicit tool setting wins, in both directions. */
export function effectiveToolMode(
  state: PrototypeState,
  group: PrototypeGroup,
  toolId: string,
): CapabilityMode {
  return state.tools[toolId] ?? groupMode(state, group);
}

export function isOverridden(state: PrototypeState, toolId: string): boolean {
  return toolId in state.tools;
}

export function overriddenToolIds(state: PrototypeState, group: PrototypeGroup): string[] {
  return group.tools.map((tool) => tool.id).filter((id) => isOverridden(state, id));
}

export function setGroupMode(
  state: PrototypeState,
  group: PrototypeGroup,
  mode: CapabilityMode,
): PrototypeState {
  // Matches applyIntegrationCapabilityMode, which merges the chosen mode in and never deletes a
  // key the user has touched.
  return { ...state, groups: { ...state.groups, [group.id]: mode } };
}

export function setToolMode(state: PrototypeState, toolId: string, mode: ToolMode): PrototypeState {
  const tools = { ...state.tools };
  // Only "Use group" clears a tool. Pinning a tool to the mode it currently inherits still counts,
  // because the user is saying "keep this one here" — and a later group change must not quietly
  // undo that.
  if (mode === "inherit") delete tools[toolId];
  else tools[toolId] = mode;
  return { ...state, tools };
}

export function clearGroupOverrides(state: PrototypeState, group: PrototypeGroup): PrototypeState {
  const tools = { ...state.tools };
  for (const id of overriddenToolIds(state, group)) delete tools[id];
  return { ...state, tools };
}

/** The jsonb payload the proposal writes, so the prototype can show it verbatim. */
export function persistedPayload(state: PrototypeState): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...state.groups };
  if (Object.keys(state.tools).length > 0) payload.tools = { ...state.tools };
  return payload;
}

export const MODE_LABELS: Record<CapabilityMode, string> = { on: "On", ask: "Ask", off: "Off" };
