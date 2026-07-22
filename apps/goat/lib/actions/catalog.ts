import { resolveGmailActions } from "@/lib/actions/gmail";
import { resolveGoogleDriveActions } from "@/lib/actions/google-drive";
import { resolveLinearActions } from "@/lib/actions/linear";
import { resolveSlackActions } from "@/lib/actions/slack";
import type { GoatActionProviderCatalog, GoatResolvedActionCatalog } from "@/lib/actions/types";

// Environment kill switch: disables chat actions for everyone without a
// deploy. Actions are otherwise on by default for any connected integration.
export function isGoatChatActionsKilled(): boolean {
  return process.env.GOAT_CHAT_ACTIONS_KILL_SWITCH === "true";
}

// Resolves the user's connected providers into a flat action catalog. A
// provider that is disconnected — or whose resolver throws — is simply absent;
// one broken provider never takes down the others.
export async function resolveGoatActionCatalog(
  userWorkosId: string,
): Promise<GoatResolvedActionCatalog> {
  const resolved = await Promise.all([
    resolveSlackActions(userWorkosId).catch(() => null),
    resolveGmailActions(userWorkosId).catch(() => null),
    resolveGoogleDriveActions(userWorkosId).catch(() => null),
    resolveLinearActions(userWorkosId).catch(() => null),
  ]);
  const providers = resolved.filter(
    (entry): entry is GoatActionProviderCatalog => entry !== null && entry.actions.length > 0,
  );
  return {
    providers: providers.map(({ id, label, description }) => ({ id, label, description })),
    actions: providers.flatMap((provider) => provider.actions),
  };
}
