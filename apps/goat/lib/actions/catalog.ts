import { listGoatWorkspaceCapabilities } from "@opencompany/db/goat-capabilities";
import { resolveAttioActions } from "@/lib/actions/attio";
import { resolveGitHubActions } from "@/lib/actions/github";
import { resolveGmailActions } from "@/lib/actions/gmail";
import { resolveGoogleCalendarActions } from "@/lib/actions/google-calendar";
import { resolveGoogleDriveActions } from "@/lib/actions/google-drive";
import { resolveLinearActions } from "@/lib/actions/linear";
import { resolveSlackActions } from "@/lib/actions/slack";
import type {
  GoatActionExecuteContext,
  GoatActionProviderCatalog,
  GoatResolvedActionCatalog,
} from "@/lib/actions/types";
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

// Environment kill switch: disables chat actions for everyone without a
// deploy. Actions are otherwise on by default for any connected integration.
export function isGoatChatActionsKilled(): boolean {
  return process.env.GOAT_CHAT_ACTIONS_KILL_SWITCH === "true";
}

// Resolves the user's connected providers into a flat action catalog. A
// provider that is disconnected — or whose resolver throws — is simply absent;
// one broken provider never takes down the others.
export async function resolveGoatActionCatalog(input: {
  userWorkosId: string;
  workspaceId: string;
}): Promise<GoatResolvedActionCatalog> {
  const resolved = await Promise.all([
    resolveSlackActions(input.userWorkosId).catch(() => null),
    resolveGmailActions(input.userWorkosId).catch(() => null),
    resolveGoogleCalendarActions(input.userWorkosId).catch(() => null),
    resolveGoogleDriveActions(input.userWorkosId).catch(() => null),
    resolveLinearActions(input.userWorkosId).catch(() => null),
    resolveAttioActions(input.userWorkosId).catch(() => null),
    resolveGitHubActions(input.workspaceId).catch(() => null),
  ]);
  const providers = resolved.filter(
    (entry): entry is GoatActionProviderCatalog => entry !== null && entry.actions.length > 0,
  );
  const managedCapabilityStates =
    process.env.MONID_API_KEY?.trim() && !isGoatManagedCapabilitiesKilled()
      ? await listGoatWorkspaceCapabilities(input.workspaceId).catch(() => [])
      : [];
  const enabledManagedSources = new Set(
    managedCapabilityStates.filter((entry) => entry.enabled).map((entry) => entry.source),
  );
  const managedActions = MANAGED_CAPABILITY_ACTIONS.filter(
    (spec) =>
      enabledManagedSources.has(spec.source) && !isGoatManagedCapabilityActionKilled(spec.id),
  ).map((spec) => ({
    id: spec.id,
    provider: spec.source,
    capability: "read" as const,
    description: spec.description,
    params: spec.params,
    timeoutMs: GOAT_CAPABILITY_ACTION_TIMEOUT_MS,
    permissionMode: "on" as const,
    execute: (params: Record<string, unknown>, context: GoatActionExecuteContext) =>
      executeManagedCapability({ spec, params, context }),
  }));
  const managedSources = managedCapabilityStates
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      id: entry.source,
      kind: "managed" as const,
      ...MANAGED_CAPABILITY_SOURCE_DETAILS[entry.source],
    }))
    .filter((source) => managedActions.some((action) => action.provider === source.id));
  return {
    providers: [
      ...providers.map(({ id, label, description }) => ({
        id,
        kind: "integration" as const,
        label,
        description,
      })),
      ...managedSources,
    ],
    actions: [...providers.flatMap((provider) => provider.actions), ...managedActions],
  };
}
