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
// Paid plugin installs are per user within a workspace, so resolution needs both identities.
export type ManagedCapabilitiesResolverInput = {
  workspaceId: string;
  userWorkosId: string;
};
export type ManagedCapabilitiesResolver = (
  input: ManagedCapabilitiesResolverInput,
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

// Resolves the user's providers into a flat action catalog. Installed plugins
// without a usable connection remain visible as sources with no actions, so
// the model and chat can explain the missing account rather than guessing.
// One broken provider never takes down the others. Managed (Monid) capabilities
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
  const unavailableConnections = await Promise.all(
    remoteMcpRegistrations
      .filter((registration) => !providers.some((provider) => provider.id === registration.source))
      .map(async (registration): Promise<ActionSourceDescriptor | null> => {
        if (registration.connectionProvider === "custom_mcp") return null;
        try {
          const state = await registration.getState(input);
          if (state.connected) return null;
          return {
            id: registration.source,
            kind: "integration",
            unavailable: true,
            label: registration.label,
            description: registration.description,
            connection: {
              pluginName: registration.pluginName,
              status:
                state.status === "needs_reauth" || state.status === "sync_failed"
                  ? "needs_reauth"
                  : "not_connected",
            },
          };
        } catch {
          return null;
        }
      }),
  );
  const managed = deps.resolveManagedCapabilities
    ? await deps
        .resolveManagedCapabilities({
          workspaceId: input.workspaceId,
          userWorkosId: input.userWorkosId,
        })
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
      ...unavailableConnections.filter(
        (source): source is ActionSourceDescriptor => source !== null,
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
