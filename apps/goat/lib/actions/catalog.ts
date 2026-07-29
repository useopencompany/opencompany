// Wrapper shim: the catalog resolver moved to @opencompany/goat-agent (shared
// with the runner). The app binds the managed-capability (Monid) resolver here,
// which stays app-side because managed execution needs server-only modules.
import {
  isGoatChatActionsKilled,
  resolveGoatActionCatalog as resolveGoatActionCatalogBase,
} from "@opencompany/goat-agent/actions/catalog";
import type { GoatResolvedActionCatalog } from "@opencompany/goat-agent/actions/types";
import { resolveGoatManagedCapabilities } from "@/lib/capabilities/resolve";

export { isGoatChatActionsKilled };

export function resolveGoatActionCatalog(input: {
  userWorkosId: string;
  workspaceId: string;
}): Promise<GoatResolvedActionCatalog> {
  return resolveGoatActionCatalogBase(input, {
    resolveManagedCapabilities: resolveGoatManagedCapabilities,
  });
}
