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
  const groups = { ...state.groups };
  // Storage stays sparse: selecting the registry default drops the key instead of writing it.
  if (mode === group.defaultMode) delete groups[group.id];
  else groups[group.id] = mode;
  return { ...state, groups };
}

export function setToolMode(
  state: PrototypeState,
  group: PrototypeGroup,
  toolId: string,
  mode: ToolMode,
): PrototypeState {
  const tools = { ...state.tools };
  // Choosing the value the tool already inherits is not an exception, so the "custom" marker
  // can never claim a difference that does not exist.
  if (mode === "inherit" || mode === groupMode(state, group)) delete tools[toolId];
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
