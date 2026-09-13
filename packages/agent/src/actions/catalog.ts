import { resolvePluginGatewayRegistrations } from "../plugin-gateway";
import { type RemoteMcpGatewayRegistration, resolveRemoteMcpActions } from "./remote-mcp";
import { resolveSessionHistoryActions } from "./session-history";
import type {
  ActionProviderCatalog,
  ActionSourceDescriptor,
  ResolvedAction,
  ResolvedActionCatalog,
} from "./types";

// Managed (Monid) capabilities are injected so each composition root can bind
// the same shared resolver only for surfaces whose persisted policy permits them.
export type ManagedCapabilitiesResolution = {
  sources: ActionSourceDescriptor[];
  actions: ResolvedAction[];
};
export type ManagedCapabilitiesResolver = (
  workspaceId: string,
) => Promise<ManagedCapabilitiesResolution>;

export type ActionCatalogDeps = {
  // Omit this for background surfaces whose policy does not permit paid capabilities.
  resolveManagedCapabilities?: ManagedCapabilitiesResolver;
  // Registration is server-side composition data. Plugin/account binding supplies these records;
  // no endpoint URL or credential material is copied into the returned action descriptors.
  remoteMcpRegistrations?: readonly RemoteMcpGatewayRegistration[];
  resolveRemoteMcpRegistrations?: typeof resolvePluginGatewayRegistrations;
};

// Environment kill switch: disables chat actions for everyone without a
// deploy. Actions are otherwise on by default for any connected integration.
export function isChatActionsKilled(): boolean {
  return process.env.OPENCOMPANY_CHAT_ACTIONS_KILL_SWITCH === "true";
}

// Resolves the user's connected providers into a flat action catalog. A
// provider that is not personally installed, disconnected — or whose resolver throws — is simply absent;
// one broken provider never takes down the others. Managed (Monid) capabilities
// are merged in only when the composition root injects their shared resolver.
export async function resolveActionCatalog(
  input: {
    userWorkosId: string;
    workspaceId: string;
    chatSessionId?: string;
  },
  deps: ActionCatalogDeps = {},
): Promise<ResolvedActionCatalog> {
  const remoteMcpRegistrations =
    deps.remoteMcpRegistrations ??
    (await (deps.resolveRemoteMcpRegistrations ?? resolvePluginGatewayRegistrations)(input).catch(
      () => [],
    ));
  const xPluginInstalled = remoteMcpRegistrations.some((registration) =>
    registration.source.startsWith("plugin:x:"),
  );
  const resolved = await Promise.all(
    remoteMcpRegistrations.map((registration) =>
      resolveRemoteMcpActions(input, registration).catch(() => null),
    ),
  );
  const providers = resolved.filter(
    (entry): entry is ActionProviderCatalog => entry !== null && entry.actions.length > 0,
  );
  const managed = deps.resolveManagedCapabilities
    ? await deps
        .resolveManagedCapabilities(input.workspaceId)
        .catch(() => ({ sources: [], actions: [] }) satisfies ManagedCapabilitiesResolution)
    : { sources: [], actions: [] };
  const reconciledManaged = xPluginInstalled
    ? {
        sources: managed.sources.filter((source) => source.id !== "x"),
        actions: managed.actions.filter((action) => action.provider !== "x"),
      }
    : managed;
  const history = input.chatSessionId ? await resolveSessionHistoryActions(input) : null;
  return {
    providers: [
      ...(history ? [history.source] : []),
      ...providers.map(
        ({ id, label, description }): ActionSourceDescriptor => ({
          id,
          kind: "integration" as const,
          label,
          description,
        }),
      ),
      ...reconciledManaged.sources,
      ...remoteMcpRegistrations
        .filter(
          (registration) =>
            registration.connectionProvider === "custom_mcp" &&
            !providers.some((provider) => provider.id === registration.source),
        )
        .map(
          (registration): ActionSourceDescriptor => ({
            id: registration.source,
            kind: "integration",
            unavailable: true,
            label: registration.label,
            description: registration.description,
          }),
        ),
    ],
    actions: [
      ...providers.flatMap((provider) => provider.actions),
      ...reconciledManaged.actions,
      ...(history?.actions ?? []),
    ],
  };
}
