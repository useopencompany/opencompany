// Wrapper shim: the catalog and managed-capability resolver are shared with the runner.
import {
  isChatActionsKilled,
  resolveActionCatalog as resolveActionCatalogBase,
} from "@opencompany/agent/actions/catalog";
import type { ResolvedActionCatalog } from "@opencompany/agent/actions/types";
import { resolveManagedCapabilities } from "@opencompany/agent/capabilities/resolve";

export { isChatActionsKilled };

export function resolveActionCatalog(input: {
  userWorkosId: string;
  workspaceId: string;
}): Promise<ResolvedActionCatalog> {
  return resolveActionCatalogBase(input, {
    resolveManagedCapabilities: resolveManagedCapabilities,
  });
}
