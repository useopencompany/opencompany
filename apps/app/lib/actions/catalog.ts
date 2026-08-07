// Wrapper shim: the catalog resolver moved to @opencompany/core (shared
// with the runner). The app binds the managed-capability (Monid) resolver here,
// which stays app-side because managed execution needs server-only modules.
import {
  isChatActionsKilled,
  resolveActionCatalog as resolveActionCatalogBase,
} from "@opencompany/core/actions/catalog";
import type { ResolvedActionCatalog } from "@opencompany/core/actions/types";
import { resolveManagedCapabilities } from "@/lib/capabilities/resolve";

export { isChatActionsKilled };

export function resolveActionCatalog(input: {
  userWorkosId: string;
  workspaceId: string;
}): Promise<ResolvedActionCatalog> {
  return resolveActionCatalogBase(input, {
    resolveManagedCapabilities: resolveManagedCapabilities,
  });
}
