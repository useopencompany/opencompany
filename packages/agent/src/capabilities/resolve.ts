import type { ManagedCapabilitiesResolution } from "@opencompany/agent/actions/catalog";
import type {
  ActionExecuteContext,
  ActionSourceDescriptor,
  ResolvedAction,
} from "@opencompany/agent/actions/types";
import { ACTION_EFFECTS_METERED_READ } from "@opencompany/agent/actions/types";
import { listWorkspaceCapabilities } from "@opencompany/db/capabilities";
import {
  isImageGenerationActionSpec,
  MANAGED_CAPABILITY_ACTIONS,
  MANAGED_CAPABILITY_SOURCE_DETAILS,
} from "./catalog";
import {
  CAPABILITY_ACTION_TIMEOUT_MS,
  executeManagedCapability,
  isManagedCapabilitiesKilled,
  isManagedCapabilityActionKilled,
} from "./execute";
import { executeImageGenerationCapability, IMAGE_GENERATION_TIMEOUT_MS } from "./image-generation";

// Managed (Monid) capabilities share the same catalog and execution service in
// every backend composition root. Workspace enablement and pricing authority
// are always loaded server-side; callers cannot opt into a capability by request.
export async function resolveManagedCapabilities(
  workspaceId: string,
): Promise<ManagedCapabilitiesResolution> {
  const managedCapabilityStates =
    (process.env.MONID_API_KEY?.trim() || process.env.VERCEL_AI_GATEWAY_API_KEY?.trim()) &&
    !isManagedCapabilitiesKilled()
      ? await listWorkspaceCapabilities(workspaceId).catch(() => [])
      : [];
  const enabledManagedSources = new Set(
    managedCapabilityStates.filter((entry) => entry.enabled).map((entry) => entry.source),
  );
  const actions: ResolvedAction[] = MANAGED_CAPABILITY_ACTIONS.filter(
    (spec) =>
      enabledManagedSources.has(spec.source) &&
      !isManagedCapabilityActionKilled(spec.id) &&
      (isImageGenerationActionSpec(spec)
        ? Boolean(process.env.VERCEL_AI_GATEWAY_API_KEY?.trim())
        : Boolean(process.env.MONID_API_KEY?.trim())),
  ).map((spec) => ({
    id: spec.id,
    provider: spec.source,
    capability: "read" as const,
    effects: ACTION_EFFECTS_METERED_READ,
    description: spec.description,
    params: spec.params,
    timeoutMs: isImageGenerationActionSpec(spec)
      ? IMAGE_GENERATION_TIMEOUT_MS
      : CAPABILITY_ACTION_TIMEOUT_MS,
    ...(spec.maxActionResultChars === undefined
      ? {}
      : { maxResultChars: spec.maxActionResultChars }),
    permissionMode: "on" as const,
    execute: (params: Record<string, unknown>, context: ActionExecuteContext) =>
      isImageGenerationActionSpec(spec)
        ? executeImageGenerationCapability({ spec, params, context })
        : executeManagedCapability({ spec, params, context }),
  }));
  const sources: ActionSourceDescriptor[] = managedCapabilityStates
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      id: entry.source,
      kind: "managed" as const,
      ...MANAGED_CAPABILITY_SOURCE_DETAILS[entry.source],
    }))
    .filter((source) => actions.some((action) => action.provider === source.id));
  return { sources, actions };
}
