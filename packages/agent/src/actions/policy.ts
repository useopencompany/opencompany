import type { ResolvedAction, ResolvedActionCatalog } from "./types";

export type ActionCatalogPolicyName = "foregroundInteractive" | "cloudReadOnly" | "headless";

export type ActionCatalogPolicy = {
  name: ActionCatalogPolicyName;
  sourceKinds: readonly ("integration" | "managed")[];
  permissionModes: readonly ("on" | "ask")[];
  approvalCapable: boolean;
  includeAction: (action: ResolvedAction) => boolean;
};

const includeEveryAction = () => true;

export const ACTION_CATALOG_POLICIES: Record<ActionCatalogPolicyName, ActionCatalogPolicy> = {
  foregroundInteractive: {
    name: "foregroundInteractive",
    sourceKinds: ["integration", "managed"],
    permissionModes: ["on", "ask"],
    approvalCapable: true,
    includeAction: includeEveryAction,
  },
  cloudReadOnly: {
    name: "cloudReadOnly",
    sourceKinds: ["integration", "managed"],
    permissionModes: ["on"],
    approvalCapable: false,
    includeAction: (action) => !action.effects.mutatesExternalSystem,
  },
  headless: {
    name: "headless",
    sourceKinds: ["integration"],
    permissionModes: ["on"],
    approvalCapable: false,
    includeAction: includeEveryAction,
  },
};

export function projectActionCatalog(
  catalog: ResolvedActionCatalog,
  policy: ActionCatalogPolicyName | ActionCatalogPolicy,
): ResolvedActionCatalog {
  const resolvedPolicy = typeof policy === "string" ? ACTION_CATALOG_POLICIES[policy] : policy;
  const allowedSourceKinds = new Set(resolvedPolicy.sourceKinds);
  const allowedPermissionModes = new Set(resolvedPolicy.permissionModes);
  const sourceIds = new Set(
    catalog.providers
      .filter((source) => allowedSourceKinds.has(source.kind ?? "integration"))
      .map((source) => source.id),
  );
  const actions = catalog.actions.filter(
    (action) =>
      sourceIds.has(action.provider) &&
      allowedPermissionModes.has(action.permissionMode) &&
      resolvedPolicy.includeAction(action),
  );
  const activeSourceIds = new Set(actions.map((action) => action.provider));

  return {
    providers: catalog.providers
      .filter((source) => activeSourceIds.has(source.id))
      .map((source) => ({ ...source, kind: source.kind ?? "integration" })),
    actions,
  };
}
