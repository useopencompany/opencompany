import type { PluginGatewayDiscoveredTool } from "@opencompany/core";
import { type CapabilityMode, isCapabilityMode } from "../actions/capabilities";
import { classifyRemoteTool, type RemoteMcpCapabilityDefinition } from "../actions/remote-mcp";
import { X_API_TOOLS, xApiToolDefinitions } from "./x-api-tools";

export function xToolName(name: string) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function xMcpToolModes(modes: Record<string, unknown>) {
  const normalized: Record<string, CapabilityMode> = {};
  for (const [name, mode] of Object.entries(modes)) {
    if (!isCapabilityMode(mode)) continue;
    normalized[xToolName(name)] = mode;
  }
  // Carry old overrides forward, while allowing a later setting under the current
  // spelling to take precedence (otherwise an old Off could never be re-enabled).
  return { ...normalized, ...modes };
}

// Older immutable X packages use OpenAPI camelCase operation ids. X's hosted MCP
// uses snake_case. Keep both explicit spellings without changing other providers.
export function xMcpCapabilities(capabilities: readonly RemoteMcpCapabilityDefinition[]) {
  const result = capabilities.map((capability) => ({
    ...capability,
    tools: [...new Set(capability.tools.flatMap((name) => [name, xToolName(name)]))],
  }));
  for (const id of ["read", "query", "write"] as const) {
    let capability = result.find((entry) => entry.id === id);
    if (!capability) {
      capability = {
        id,
        label:
          id === "read"
            ? "Research public X data"
            : id === "query"
              ? "Read account & private X data"
              : "Manage X",
        defaultMode: id === "read" ? "on" : "ask",
        tools: [],
      };
      result.push(capability);
    }
    capability.tools = [
      ...new Set([
        ...capability.tools,
        ...X_API_TOOLS.filter((tool) => tool.capability === id).map((tool) => tool.name),
      ]),
    ];
  }
  return result;
}

export function xMcpDiscoverySnapshot(
  snapshot: readonly PluginGatewayDiscoveredTool[],
  capabilities: readonly RemoteMcpCapabilityDefinition[],
): PluginGatewayDiscoveredTool[] {
  const supplemental = xApiToolDefinitions();
  const names = new Set(supplemental.map((tool) => tool.name));
  return [...snapshot.filter((tool) => !names.has(tool.name)), ...supplemental].map((tool) => {
    const classification = classifyRemoteTool(tool, capabilities);
    return {
      ...tool,
      classification: {
        capabilityId: classification.capability.id,
        capabilityLabel: classification.capability.label,
        defaultMode: classification.capability.defaultMode,
        bucket: classification.bucket,
        curated: classification.curated,
      },
    };
  });
}
