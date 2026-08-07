import type { GoatResolvedActionCatalog, ResolvedGoatAction } from "./types";

export type GoatActionCatalogPolicyName = "foregroundInteractive" | "cloudReadOnly" | "headless";

export type GoatActionCatalogPolicy = {
  name: GoatActionCatalogPolicyName;
  sourceKinds: readonly ("integration" | "managed")[];
  permissionModes: readonly ("on" | "ask")[];
  approvalCapable: boolean;
  includeAction: (action: ResolvedGoatAction) => boolean;
};

const includeEveryAction = () => true;

export const GOAT_ACTION_CATALOG_POLICIES: Record<
  GoatActionCatalogPolicyName,
  GoatActionCatalogPolicy
> = {
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
  catalog: GoatResolvedActionCatalog,
  policy: GoatActionCatalogPolicyName | GoatActionCatalogPolicy,
): GoatResolvedActionCatalog {
  const resolvedPolicy = typeof policy === "string" ? GOAT_ACTION_CATALOG_POLICIES[policy] : policy;
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
