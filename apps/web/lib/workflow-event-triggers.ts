import type {
  CompanyGitHubInstallationDto,
  CompanyGitHubPluginDto,
  PluginEventDefinitionDto,
  PluginListItemDto,
} from "@opencompany/protocol";
import type { IntegrationAccountView } from "@/lib/integration-state";
import {
  isOfficialMcpPluginName,
  OFFICIAL_MCP_PLUGIN_METADATA,
  type OfficialMcpPluginMetadata,
} from "@/lib/official-plugins";

// One installable provider the workflow trigger picker can offer: the events its plugin declares
// and the user has switched on, plus the connected accounts an event trigger may bind to.
export type WorkflowEventProviderOption = {
  provider: string;
  label: string;
  // Where to connect an account this provider's events can bind to.
  accountHref: string;
  accountLabel: string;
  accounts: { integrationId: string; label: string }[];
  events: PluginEventDefinitionDto[];
};

// A provider can be picked only when it has both an enabled event and an account to bind it to;
// the picker still lists a provider that is missing one so the zero state can say which.
export function workflowEventProviderOptions(input: {
  plugins: readonly PluginListItemDto[];
  personalAccounts: Record<string, IntegrationAccountView[] | undefined>;
  companyGitHub?: CompanyGitHubPluginDto | null;
}): WorkflowEventProviderOption[] {
  const personal = input.plugins.flatMap((plugin: PluginListItemDto) => {
    if (plugin.status !== "enabled") return [];
    const events = plugin.events.filter(
      (event: PluginEventDefinitionDto) => plugin.eventModes[event.id] === true,
    );
    if (events.length === 0) return [];
    const provider: string = plugin.name;
    const metadata: OfficialMcpPluginMetadata | null = isOfficialMcpPluginName(provider)
      ? OFFICIAL_MCP_PLUGIN_METADATA[provider]
      : null;
    return [
      {
        provider,
        label: metadata?.label ?? provider,
        accountHref: metadata?.eventAccountHref ?? `/plugins/${provider}`,
        accountLabel: metadata?.eventAccountLabel ?? `Connect ${metadata?.label ?? provider}`,
        accounts: (input.personalAccounts[provider] ?? [])
          .filter((account) => account.connected)
          .map((account) => ({
            integrationId: account.integrationId,
            label:
              account.connectionLabel ??
              account.accountName ??
              account.accountEmail ??
              metadata?.label ??
              provider,
          })),
        events,
      },
    ];
  });
  return input.companyGitHub
    ? [...personal, companyGitHubEventProvider(input.companyGitHub)]
    : personal;
}

// The company GitHub plugin binds to accounts an admin linked for the whole workspace, so there is
// no personal installation or event opt-in to wait for.
function companyGitHubEventProvider(plugin: CompanyGitHubPluginDto): WorkflowEventProviderOption {
  return {
    provider: "github-app",
    label: "GitHub (company)",
    accountHref: "/plugins/company/github",
    accountLabel: plugin.canManage ? "Connect GitHub" : "Ask an admin to connect GitHub",
    accounts: plugin.installations
      .filter((installation: CompanyGitHubInstallationDto) => installation.status === "connected")
      .map((installation: CompanyGitHubInstallationDto) => ({
        integrationId: installation.integrationId,
        label: installation.accountLogin,
      })),
    events: plugin.events,
  };
}

export function workflowEventProvidersReady(providers: readonly WorkflowEventProviderOption[]) {
  return providers.some((provider) => provider.accounts.length > 0 && provider.events.length > 0);
}
