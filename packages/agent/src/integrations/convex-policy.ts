import type { CapabilityId } from "../actions/capabilities";

export const CONVEX_TOOL_CAPABILITIES = {
  status: "read",
  tables: "read",
  functionSpec: "read",
  data: "query",
  logs: "query",
  runOneoffQuery: "query",
  run: "write",
  envGet: "draft",
  envList: "draft",
  envSet: "draft",
  envRemove: "draft",
} as const satisfies Record<string, CapabilityId>;

export type ConvexToolName = keyof typeof CONVEX_TOOL_CAPABILITIES;

export function parseConvexDeployKey(value: string) {
  // Only cloud deployment keys: reject personal/project/preview tokens, URLs, and admin keys.
  const match = /^(dev|prod):([a-z][a-z0-9-]{1,61}[a-z0-9])\|([A-Za-z0-9_+/=-]{8,3500})$/u.exec(
    value,
  );
  return match ? { type: match[1] as "dev" | "prod", name: match[2]! } : null;
}

export function isConvexToolName(value: string): value is ConvexToolName {
  return Object.hasOwn(CONVEX_TOOL_CAPABILITIES, value);
}

export function convexToolAllowedInProduction(tool: ConvexToolName) {
  return CONVEX_TOOL_CAPABILITIES[tool] === "read";
}
