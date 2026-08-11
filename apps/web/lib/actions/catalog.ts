// Wrapper shim: the catalog and managed-capability resolver are shared with the runner.
import {
  isGoatChatActionsKilled,
  resolveGoatActionCatalog as resolveGoatActionCatalogBase,
} from "@opencompany/goat-agent/actions/catalog";
import type { GoatResolvedActionCatalog } from "@opencompany/goat-agent/actions/types";
import { resolveGoatManagedCapabilities } from "@opencompany/goat-agent/capabilities/resolve";

export { isGoatChatActionsKilled };

export function resolveGoatActionCatalog(input: {
  userWorkosId: string;
  workspaceId: string;
}): Promise<GoatResolvedActionCatalog> {
  return resolveGoatActionCatalogBase(input, {
    resolveManagedCapabilities: resolveGoatManagedCapabilities,
  });
}
