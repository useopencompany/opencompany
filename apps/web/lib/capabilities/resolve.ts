import { listGoatWorkspaceCapabilities } from "@opencompany/db/goat-capabilities";
import type { GoatManagedCapabilitiesResolution } from "@opencompany/goat-agent/actions/catalog";
import type {
  GoatActionExecuteContext,
  GoatActionSourceDescriptor,
  ResolvedGoatAction,
} from "@opencompany/goat-agent/actions/types";
import { GOAT_ACTION_EFFECTS_METERED_READ } from "@opencompany/goat-agent/actions/types";
import {
  MANAGED_CAPABILITY_ACTIONS,
  MANAGED_CAPABILITY_SOURCE_DETAILS,
} from "@/lib/capabilities/catalog";
import {
  executeManagedCapability,
  GOAT_CAPABILITY_ACTION_TIMEOUT_MS,
  isGoatManagedCapabilitiesKilled,
  isGoatManagedCapabilityActionKilled,
} from "@/lib/capabilities/execute";

// Managed (Monid) capabilities are resolved app-side because executing them
// needs server-only modules + billing. Injected into the shared
// resolveGoatActionCatalog (@opencompany/goat-agent) so the runner — which never
// exposes managed capabilities — can keep the loop identical without pulling in
// this branch. Was previously inline in apps/goat/lib/actions/catalog.ts.
export async function resolveGoatManagedCapabilities(
  workspaceId: string,
): Promise<GoatManagedCapabilitiesResolution> {
  const managedCapabilityStates =
    process.env.MONID_API_KEY?.trim() && !isGoatManagedCapabilitiesKilled()
      ? await listGoatWorkspaceCapabilities(workspaceId).catch(() => [])
      : [];
  const enabledManagedSources = new Set(
    managedCapabilityStates.filter((entry) => entry.enabled).map((entry) => entry.source),
  );
  const actions: ResolvedGoatAction[] = MANAGED_CAPABILITY_ACTIONS.filter(
    (spec) =>
      enabledManagedSources.has(spec.source) && !isGoatManagedCapabilityActionKilled(spec.id),
  ).map((spec) => ({
    id: spec.id,
    provider: spec.source,
    capability: "read" as const,
    effects: GOAT_ACTION_EFFECTS_METERED_READ,
    description: spec.description,
    params: spec.params,
    timeoutMs: GOAT_CAPABILITY_ACTION_TIMEOUT_MS,
    ...(spec.maxActionResultChars === undefined
      ? {}
      : { maxResultChars: spec.maxActionResultChars }),
    permissionMode: "on" as const,
    execute: (params: Record<string, unknown>, context: GoatActionExecuteContext) =>
      executeManagedCapability({ spec, params, context }),
  }));
  const sources: GoatActionSourceDescriptor[] = managedCapabilityStates
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      id: entry.source,
      kind: "managed" as const,
      ...MANAGED_CAPABILITY_SOURCE_DETAILS[entry.source],
    }))
    .filter((source) => actions.some((action) => action.provider === source.id));
  return { sources, actions };
}
