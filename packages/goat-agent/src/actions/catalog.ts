import { resolveAttioActions } from "./attio";
import { resolveGitHubActions } from "./github";
import { resolveGmailActions } from "./gmail";
import { resolveGoogleCalendarActions } from "./google-calendar";
import { resolveGoogleDriveActions } from "./google-drive";
import { resolveLinearActions } from "./linear";
import { resolveSlackActions } from "./slack";
import { resolveStripeActions } from "./stripe";
import type {
  GoatActionProviderCatalog,
  GoatActionSourceDescriptor,
  GoatResolvedActionCatalog,
  ResolvedGoatAction,
} from "./types";

// Managed (Monid) capabilities need server-only execution + billing, so their
// resolution lives in the host app (apps/goat) and is injected here. The runner
// passes nothing — background/headless runs never expose managed capabilities
// (they require a persisted chat session + approval), exactly like the Slack bot.
export type GoatManagedCapabilitiesResolution = {
  sources: GoatActionSourceDescriptor[];
  actions: ResolvedGoatAction[];
};
export type GoatManagedCapabilitiesResolver = (
  workspaceId: string,
) => Promise<GoatManagedCapabilitiesResolution>;

export type GoatActionCatalogDeps = {
  // Injected by the host app to add managed (Monid) capabilities. Omitted by
  // the runner so tasks never surface managed actions.
  resolveManagedCapabilities?: GoatManagedCapabilitiesResolver;
};

// Environment kill switch: disables chat actions for everyone without a
// deploy. Actions are otherwise on by default for any connected integration.
export function isGoatChatActionsKilled(): boolean {
  return process.env.GOAT_CHAT_ACTIONS_KILL_SWITCH === "true";
}

// Resolves the user's connected providers into a flat action catalog. A
// provider that is disconnected — or whose resolver throws — is simply absent;
// one broken provider never takes down the others. Managed (Monid) capabilities
// are merged in only when the host app injects a resolver.
export async function resolveGoatActionCatalog(
  input: {
    userWorkosId: string;
    workspaceId: string;
  },
  deps: GoatActionCatalogDeps = {},
): Promise<GoatResolvedActionCatalog> {
  const resolved = await Promise.all([
    resolveSlackActions(input.userWorkosId).catch(() => null),
    resolveGmailActions(input.userWorkosId).catch(() => null),
    resolveGoogleCalendarActions(input.userWorkosId).catch(() => null),
    resolveGoogleDriveActions(input.userWorkosId).catch(() => null),
    resolveLinearActions(input.userWorkosId).catch(() => null),
    resolveAttioActions(input.userWorkosId).catch(() => null),
    resolveGitHubActions(input.workspaceId).catch(() => null),
    resolveStripeActions(input.workspaceId).catch(() => null),
  ]);
  const providers = resolved.filter(
    (entry): entry is GoatActionProviderCatalog => entry !== null && entry.actions.length > 0,
  );
  const managed = deps.resolveManagedCapabilities
    ? await deps
        .resolveManagedCapabilities(input.workspaceId)
        .catch(() => ({ sources: [], actions: [] }) satisfies GoatManagedCapabilitiesResolution)
    : { sources: [], actions: [] };
  return {
    providers: [
      ...providers.map(
        ({ id, label, description }): GoatActionSourceDescriptor => ({
          id,
          kind: "integration" as const,
          label,
          description,
        }),
      ),
      ...managed.sources,
    ],
    actions: [...providers.flatMap((provider) => provider.actions), ...managed.actions],
  };
}
