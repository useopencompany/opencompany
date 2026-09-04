import { resolvePluginGatewayRegistrations } from "../plugin-gateway";
import { resolveAttioActions } from "./attio";
import { resolveGmailActions } from "./gmail";
import { resolveGoogleCalendarActions } from "./google-calendar";
import { resolveGoogleDriveActions } from "./google-drive";
import { resolveLatitudeActions } from "./latitude";
import { resolveLinearActions } from "./linear";
import { resolveNeonActions } from "./neon";
import { resolvePostHogActions } from "./posthog";
import { type RemoteMcpGatewayRegistration, resolveRemoteMcpActions } from "./remote-mcp";
import { resolveRevolutActions } from "./revolut";
import { resolveStripeActions } from "./stripe";
import type {
  ActionProviderCatalog,
  ActionSourceDescriptor,
  ResolvedAction,
  ResolvedActionCatalog,
} from "./types";
import { resolveXAccountActions } from "./x-account";

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
// provider that is disconnected — or whose resolver throws — is simply absent;
// one broken provider never takes down the others. Managed (Monid) capabilities
// are merged in only when the composition root injects their shared resolver.
export async function resolveActionCatalog(
  input: {
    userWorkosId: string;
    workspaceId: string;
  },
  deps: ActionCatalogDeps = {},
): Promise<ResolvedActionCatalog> {
  const remoteMcpRegistrations =
    deps.remoteMcpRegistrations ??
    (await (deps.resolveRemoteMcpRegistrations ?? resolvePluginGatewayRegistrations)(input).catch(
      () => [],
    ));
  const linearPluginInstalled = remoteMcpRegistrations.some((registration) =>
    registration.source.startsWith("plugin:linear:"),
  );
  const attioPluginInstalled = remoteMcpRegistrations.some((registration) =>
    registration.source.startsWith("plugin:attio:"),
  );
  const gmailPluginInstalled = remoteMcpRegistrations.some((registration) =>
    registration.source.startsWith("plugin:gmail:"),
  );
  const googleDrivePluginInstalled = remoteMcpRegistrations.some((registration) =>
    registration.source.startsWith("plugin:google-drive:"),
  );
  const googleCalendarPluginInstalled = remoteMcpRegistrations.some((registration) =>
    registration.source.startsWith("plugin:google-calendar:"),
  );
  const neonPluginInstalled = remoteMcpRegistrations.some((registration) =>
    registration.source.startsWith("plugin:neon:"),
  );
  const posthogPluginInstalled = remoteMcpRegistrations.some((registration) =>
    registration.source.startsWith("plugin:posthog:"),
  );
  const latitudePluginInstalled = remoteMcpRegistrations.some((registration) =>
    registration.source.startsWith("plugin:latitude:"),
  );
  const stripePluginInstalled = remoteMcpRegistrations.some((registration) =>
    registration.source.startsWith("plugin:stripe:"),
  );
  const xPluginInstalled = remoteMcpRegistrations.some((registration) =>
    registration.source.startsWith("plugin:x:"),
  );
  const resolved = await Promise.all([
    gmailPluginInstalled ? null : resolveGmailActions(input.userWorkosId).catch(() => null),
    googleCalendarPluginInstalled
      ? null
      : resolveGoogleCalendarActions(input.userWorkosId).catch(() => null),
    googleDrivePluginInstalled
      ? null
      : resolveGoogleDriveActions(input.userWorkosId).catch(() => null),
    linearPluginInstalled ? null : resolveLinearActions(input.userWorkosId).catch(() => null),
    posthogPluginInstalled ? null : resolvePostHogActions(input.userWorkosId).catch(() => null),
    latitudePluginInstalled ? null : resolveLatitudeActions(input.userWorkosId).catch(() => null),
    neonPluginInstalled ? null : resolveNeonActions(input.userWorkosId).catch(() => null),
    attioPluginInstalled ? null : resolveAttioActions(input.userWorkosId).catch(() => null),
    stripePluginInstalled ? null : resolveStripeActions(input.workspaceId).catch(() => null),
    resolveRevolutActions(input.workspaceId).catch(() => null),
    xPluginInstalled ? null : resolveXAccountActions(input.userWorkosId).catch(() => null),
    ...remoteMcpRegistrations.map((registration) =>
      resolveRemoteMcpActions(input, registration).catch(() => null),
    ),
  ]);
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
  return {
    providers: [
      ...providers.map(
        ({ id, label, description }): ActionSourceDescriptor => ({
          id,
          kind: "integration" as const,
          label,
          description,
        }),
      ),
      ...reconciledManaged.sources,
    ],
    actions: [...providers.flatMap((provider) => provider.actions), ...reconciledManaged.actions],
  };
}
