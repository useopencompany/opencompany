"use client";

import type {
  PluginImportPreviewDto,
  PluginInstallationDto,
  PluginRemoteMcpServerDto,
} from "@opencompany/protocol";
import { Alert, AlertDescription, AlertTitle } from "@opencompany/ui/components/alert";
import { Badge } from "@opencompany/ui/components/badge";
import { Button, buttonVariants } from "@opencompany/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@opencompany/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { Skeleton } from "@opencompany/ui/components/skeleton";
import { toast } from "@opencompany/ui/components/sonner";
import {
  AlertCircle,
  ChevronDown,
  ExternalLink,
  Loader2,
  PackageCheck,
  PlugZap,
  RefreshCw,
  Sparkles,
  Unplug,
  Users,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useAppData } from "@/components/AppDataProvider";
import { CapabilityModeToggle } from "@/components/CapabilityModeToggle";
import { GitHubRepositoryAccessSection } from "@/components/GitHubRepositoryAccess";
import {
  installOfficialMcpPlugin,
  OFFICIAL_MCP_PLUGINS,
  type OfficialMcpPluginConfig,
} from "@/components/PluginSettings";
import { RenderApiKeyConnectionForm } from "@/components/RenderApiKeyConnectionForm";
import { SettingsContent } from "@/components/SettingsChrome";
import {
  InfisicalWorkspaceConnectionCard,
  IntegrationAccountRow,
  IntegrationSetupFeedback,
} from "@/components/SettingsIntegrationsPanel";
import { StripeRestrictedKeyConnectionForm } from "@/components/StripeRestrictedKeyConnectionForm";
import {
  type CapabilityId,
  type CapabilityMode,
  effectiveCapabilityMode,
  providerCapabilities,
} from "@/lib/actions/capabilities";
import {
  archiveHeadlessPlugin,
  enableHeadlessPlugin,
  previewHeadlessPluginImport,
  refreshHeadlessPluginMcp,
} from "@/lib/headless-knowledge-commands";
import { setIntegrationCapabilityModeAction } from "@/lib/integration-account-actions";
import {
  type InfisicalProviderState,
  type IntegrationAccountView,
  type IntegrationState,
  type PersonalAccountProvider,
} from "@/lib/integration-state";
import {
  GOOGLE_DRIVE_MCP_RECONNECT_REASON,
  googleDriveMcpScopesSatisfied,
} from "@/lib/integrations/google-drive-scopes";
import type { OfficialMcpPluginName } from "@/lib/official-plugins";

const NO_CONNECTION_DISCOVERY_ERROR =
  "No usable provider connection was available for MCP discovery.";

export type PluginLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; plugin: PluginInstallationDto | null };

export type PluginToolView = {
  id: string;
  name: string;
  description: string | null;
  readOnly: boolean;
};

export type PluginToolGroupView = {
  id: string;
  label: string;
  description: string;
  modeKey: CapabilityId;
  defaultMode: CapabilityMode;
  curated: boolean;
  tools: PluginToolView[];
};

export type PluginToolsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      groups: PluginToolGroupView[];
      discovery: {
        status: "pending" | "ready" | "stale" | "error";
        toolCount: number;
        discoveredAt: string | null;
        refreshAfter: string | null;
        lastDiscoveryError: string | null;
      };
    };

type PluginConnectionProvider = PersonalAccountProvider | "posthog" | "stripe";
type PluginAccount = { account: IntegrationAccountView<PluginConnectionProvider> };

type PluginSkill = {
  id: string;
  name: string;
  description: string;
};

type PluginPreviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; preview: PluginImportPreviewDto };

export type PluginAccountsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      accounts: PluginAccount[];
      permissionConnection: IntegrationAccountView<PluginConnectionProvider> | null;
      workspaceInfisical?: InfisicalProviderState;
    };

export type LinearAccountsState = PluginAccountsState;

export function AttioPluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.attio}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function BetterStackPluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.betterstack}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function FathomPluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.fathom}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function GitHubPluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.github}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function GmailPluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.gmail}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function GranolaPluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.granola}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function GoogleCalendarPluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS["google-calendar"]}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function GoogleDrivePluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS["google-drive"]}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function HubSpotPluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.hubspot}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function InfisicalPluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.infisical}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function LatitudePluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.latitude}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function LinearPluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.linear}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function JamiePluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.jamie}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function NeonPluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.neon}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function RenderPluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.render}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function VercelPluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.vercel}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function PostHogPluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.posthog}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function SlackPluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.slack}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function StripePluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.stripe}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function SigNozPluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.signoz}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

export function XPluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  return (
    <OfficialMcpPluginDetail
      config={OFFICIAL_MCP_PLUGINS.x}
      pluginState={pluginState}
      canEdit={canEdit}
      {...(toolsState ? { toolsState } : {})}
    />
  );
}

function OfficialMcpPluginDetail({
  config,
  pluginState,
  canEdit,
  toolsState,
}: {
  config: OfficialMcpPluginConfig;
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  const { integrations } = useAppData();
  const accountsState = useMemo<PluginAccountsState>(
    () => ({ status: "ready", ...pluginAccountsFromState(integrations, config) }),
    [config, integrations],
  );
  const effectiveToolsState =
    toolsState ??
    (pluginState.status === "loading"
      ? { status: "loading" as const }
      : pluginState.status === "error"
        ? { status: "error" as const, message: pluginState.message }
        : officialPluginToolsStateFromPlugin(pluginState.plugin, config.name));

  return (
    <OfficialMcpPluginDetailView
      config={config}
      pluginState={pluginState}
      accountsState={accountsState}
      toolsState={effectiveToolsState}
      canEdit={canEdit}
    />
  );
}

export function LinearPluginDetailView({
  pluginState,
  accountsState,
  toolsState,
  canEdit,
}: {
  pluginState: PluginLoadState;
  accountsState: LinearAccountsState;
  toolsState: PluginToolsState;
  canEdit: boolean;
}) {
  return (
    <OfficialMcpPluginDetailView
      config={OFFICIAL_MCP_PLUGINS.linear}
      pluginState={pluginState}
      accountsState={accountsState}
      toolsState={toolsState}
      canEdit={canEdit}
    />
  );
}

export function GitHubPluginDetailView({
  pluginState,
  accountsState,
  toolsState,
  canEdit,
}: {
  pluginState: PluginLoadState;
  accountsState: PluginAccountsState;
  toolsState: PluginToolsState;
  canEdit: boolean;
}) {
  return (
    <OfficialMcpPluginDetailView
      config={OFFICIAL_MCP_PLUGINS.github}
      pluginState={pluginState}
      accountsState={accountsState}
      toolsState={toolsState}
      canEdit={canEdit}
    />
  );
}

export function GmailPluginDetailView({
  pluginState,
  accountsState,
  toolsState,
  canEdit,
}: {
  pluginState: PluginLoadState;
  accountsState: PluginAccountsState;
  toolsState: PluginToolsState;
  canEdit: boolean;
}) {
  return (
    <OfficialMcpPluginDetailView
      config={OFFICIAL_MCP_PLUGINS.gmail}
      pluginState={pluginState}
      accountsState={accountsState}
      toolsState={toolsState}
      canEdit={canEdit}
    />
  );
}

export function GoogleDrivePluginDetailView({
  pluginState,
  accountsState,
  toolsState,
  canEdit,
}: {
  pluginState: PluginLoadState;
  accountsState: PluginAccountsState;
  toolsState: PluginToolsState;
  canEdit: boolean;
}) {
  return (
    <OfficialMcpPluginDetailView
      config={OFFICIAL_MCP_PLUGINS["google-drive"]}
      pluginState={pluginState}
      accountsState={accountsState}
      toolsState={toolsState}
      canEdit={canEdit}
    />
  );
}

export function NeonPluginDetailView({
  pluginState,
  accountsState,
  toolsState,
  canEdit,
}: {
  pluginState: PluginLoadState;
  accountsState: PluginAccountsState;
  toolsState: PluginToolsState;
  canEdit: boolean;
}) {
  return (
    <OfficialMcpPluginDetailView
      config={OFFICIAL_MCP_PLUGINS.neon}
      pluginState={pluginState}
      accountsState={accountsState}
      toolsState={toolsState}
      canEdit={canEdit}
    />
  );
}

export function BetterStackPluginDetailView({
  pluginState,
  accountsState,
  toolsState,
  canEdit,
}: {
  pluginState: PluginLoadState;
  accountsState: PluginAccountsState;
  toolsState: PluginToolsState;
  canEdit: boolean;
}) {
  return (
    <OfficialMcpPluginDetailView
      config={OFFICIAL_MCP_PLUGINS.betterstack}
      pluginState={pluginState}
      accountsState={accountsState}
      toolsState={toolsState}
      canEdit={canEdit}
    />
  );
}

export function SlackPluginDetailView({
  pluginState,
  accountsState,
  toolsState,
  canEdit,
}: {
  pluginState: PluginLoadState;
  accountsState: PluginAccountsState;
  toolsState: PluginToolsState;
  canEdit: boolean;
}) {
  return (
    <OfficialMcpPluginDetailView
      config={OFFICIAL_MCP_PLUGINS.slack}
      pluginState={pluginState}
      accountsState={accountsState}
      toolsState={toolsState}
      canEdit={canEdit}
    />
  );
}

function OfficialMcpPluginDetailView({
  config,
  pluginState,
  accountsState,
  toolsState,
  canEdit,
}: {
  config: OfficialMcpPluginConfig;
  pluginState: PluginLoadState;
  accountsState: PluginAccountsState;
  toolsState: PluginToolsState;
  canEdit: boolean;
}) {
  const plugin = pluginState.status === "ready" ? pluginState.plugin : null;
  const shouldPreview = pluginState.status === "ready" && !pluginState.plugin;
  const [previewState, setPreviewState] = useState<PluginPreviewState>({ status: "loading" });

  useEffect(() => {
    if (!shouldPreview) return;
    let active = true;
    void previewHeadlessPluginImport({ url: config.source })
      .then((preview) => {
        if (active) setPreviewState({ status: "ready", preview });
      })
      .catch((cause) => {
        if (active) setPreviewState({ status: "error", message: errorMessage(cause) });
      });
    return () => {
      active = false;
    };
  }, [config.source, shouldPreview]);

  return (
    <>
      <IntegrationSetupFeedback />
      <SettingsContent
        title={config.label}
        description={plugin?.manifest.description || config.description}
        backLink={{ href: "/settings/plugins", label: "Plugins" }}
      >
        <PluginHeaderSection
          config={config}
          state={pluginState}
          previewState={previewState}
          canEdit={canEdit}
        />
        {plugin ? (
          <AccountsSection config={config} state={accountsState} canEdit={canEdit} />
        ) : null}
        {plugin &&
        config.name === "github" &&
        accountsState.status === "ready" &&
        accountsState.permissionConnection ? (
          <GitHubRepositoryAccessSection />
        ) : null}
        <ToolsSection
          config={config}
          pluginState={pluginState}
          previewState={previewState}
          state={toolsState}
          canEdit={canEdit}
          permissionConnection={
            accountsState.status === "ready" ? accountsState.permissionConnection : null
          }
        />
        <SkillsSection config={config} state={pluginState} previewState={previewState} />
      </SettingsContent>
    </>
  );
}

function PluginHeaderSection({
  config,
  state,
  previewState,
  canEdit,
}: {
  config: OfficialMcpPluginConfig;
  state: PluginLoadState;
  previewState: PluginPreviewState;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (state.status === "loading") {
    return <SectionSkeleton label={`Loading ${config.label} plugin`} rows={2} />;
  }
  if (state.status === "error") {
    return <SectionError title="Plugin details unavailable" message={state.message} />;
  }

  const plugin = state.plugin;
  const install = () => {
    if (plugin || isPending) return;
    setError(null);
    startTransition(async () => {
      try {
        await installOfficialMcpPlugin(
          config,
          previewState.status === "ready" ? previewState.preview : undefined,
        );
        toast.success(`${config.label} installed.`);
        router.refresh();
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  };
  const Icon = config.Icon;
  const enable = () => {
    if (!plugin) return;
    setError(null);
    startTransition(async () => {
      try {
        await enableHeadlessPlugin(plugin.name);
        router.refresh();
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  };
  const uninstall = () => {
    if (!plugin) return;
    setError(null);
    startTransition(async () => {
      try {
        await archiveHeadlessPlugin(plugin.name);
        setConfirmingUninstall(false);
        router.refresh();
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  };

  return (
    <section aria-labelledby="plugin-overview-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-3 rounded-lg border border-border bg-surface p-4">
        <span
          className={`flex size-11 shrink-0 items-center justify-center rounded-lg ${config.iconClassName}`}
        >
          <Icon className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="plugin-overview-heading" className="text-[15px] font-semibold text-ink">
              {config.label}
            </h2>
            {plugin ? (
              <Badge variant={plugin.status === "enabled" ? "success" : "outline"}>
                {plugin.status === "enabled" ? "Installed" : "Disabled"}
              </Badge>
            ) : (
              <Badge variant="outline">Not installed</Badge>
            )}
          </div>
          <p className="mt-1 text-[12.5px] leading-5 text-ink-subtle">
            {plugin?.manifest.description || config.description}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {plugin ? (
            <Link
              href={pinnedSourceUrl(plugin)}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              View source <ExternalLink className="size-3.5" />
            </Link>
          ) : null}
          {canEdit ? (
            plugin ? (
              <>
                {plugin.status === "disabled" ? (
                  <Button size="sm" disabled={isPending} onClick={enable}>
                    <PlugZap className="size-3.5" /> Enable
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isPending}
                  onClick={() => setConfirmingUninstall(true)}
                >
                  <Unplug className="size-3.5" /> Uninstall
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                disabled={isPending || previewState.status !== "ready"}
                onClick={install}
              >
                {isPending || previewState.status === "loading" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <PlugZap className="size-3.5" />
                )}
                {isPending
                  ? "Installing…"
                  : previewState.status === "loading"
                    ? "Loading package…"
                    : previewState.status === "error"
                      ? "Install unavailable"
                      : "Install"}
              </Button>
            )
          ) : null}
        </div>
      </div>

      {plugin ? (
        <details className="group rounded-lg border border-border bg-surface-muted">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[12px] font-medium text-ink-muted">
            Advanced package details
            <ChevronDown className="ml-auto size-3.5 transition-transform group-open:rotate-180" />
          </summary>
          <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-border px-3 py-2.5 text-[11.5px] leading-4">
            <dt className="text-ink-faint">Source</dt>
            <dd className="break-all text-ink">{plugin.source.url}</dd>
            <dt className="text-ink-faint">Commit</dt>
            <dd className="break-all font-mono text-ink">{plugin.source.resolvedCommit}</dd>
            <dt className="text-ink-faint">Integrity</dt>
            <dd className="break-all font-mono text-ink">{plugin.integrity}</dd>
          </dl>
        </details>
      ) : (
        <SectionEmpty icon={PackageCheck}>
          Review the package tools and skills below, then install when you are ready.
        </SectionEmpty>
      )}

      {!canEdit ? (
        <p className="text-[12px] leading-4 text-ink-subtle">
          Only workspace admins can install or uninstall plugins.
        </p>
      ) : null}
      {error ? <SectionError title="Plugin update failed" message={error} /> : null}

      <Dialog open={confirmingUninstall} onOpenChange={setConfirmingUninstall}>
        <DialogContent className="max-w-[440px] gap-5">
          <DialogHeader className="text-left">
            <DialogTitle className="text-[15px]">Uninstall {config.label}?</DialogTitle>
            <DialogDescription className="text-[12.5px] leading-5 text-ink-subtle">
              {config.label} tools and plugin skills will be removed. Connected accounts will not be
              changed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmingUninstall(false)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" disabled={isPending} onClick={uninstall}>
              {isPending ? <Loader2 className="animate-spin" /> : <Unplug />}
              Uninstall
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function AccountsSection({
  config,
  state,
  canEdit,
}: {
  config: OfficialMcpPluginConfig;
  state: PluginAccountsState;
  canEdit: boolean;
}) {
  const permissionConnection = state.status === "ready" ? state.permissionConnection : null;
  const workspaceInfisical = state.status === "ready" ? state.workspaceInfisical : undefined;
  const displayedAccounts =
    state.status !== "ready"
      ? []
      : config.connectionProvider === "slack" || config.connectionProvider === "x_account"
        ? state.accounts
        : permissionConnection
          ? [{ account: permissionConnection }]
          : [];
  const headingId = `${config.name}-accounts-heading`;
  const accountLabel = config.accountLabel ?? config.label;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeading
        id={headingId}
        icon={Users}
        title="Accounts"
        description={config.accountDescription}
      />
      {state.status === "loading" ? (
        <SectionSkeleton label={`Loading ${accountLabel} accounts`} rows={2} compact />
      ) : state.status === "error" ? (
        <SectionError title="Accounts unavailable" message={state.message} />
      ) : config.name === "infisical" && workspaceInfisical ? (
        <InfisicalWorkspaceConnectionCard integration={workspaceInfisical} canManage={canEdit} />
      ) : displayedAccounts.length === 0 ? (
        <SectionEmpty icon={Users}>{`No ${accountLabel} accounts are connected.`}</SectionEmpty>
      ) : config.name === "stripe" ? (
        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-ink-subtle">
            {permissionConnection?.connectionLabel ||
              permissionConnection?.accountName ||
              permissionConnection?.integrationId}
          </span>
          <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle">
            {permissionConnection?.connected ? "Connected" : "Needs reconnect"}
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {displayedAccounts.map(({ account }) => (
            <IntegrationAccountRow
              key={account.integrationId}
              account={account as IntegrationAccountView<PersonalAccountProvider | "posthog">}
              purposeLabel={
                config.connectionProvider === "slack"
                  ? account.integrationId === permissionConnection?.integrationId
                    ? "Slack tools"
                    : "Not active"
                  : config.connectionProvider === "x_account"
                    ? account.integrationId === permissionConnection?.integrationId
                      ? "X tools"
                      : "Legacy fallback"
                    : accountLabel
              }
              reconnectHref={config.connectHref}
              showCapabilityModes={false}
            />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {config.name === "infisical" ? null : config.name === "render" ? (
          <RenderApiKeyConnectionForm connected={Boolean(permissionConnection?.connected)} />
        ) : config.name === "stripe" ? (
          <StripeRestrictedKeyConnectionForm
            connected={Boolean(permissionConnection?.connected)}
            canManage={canEdit}
          />
        ) : (
          <a
            href={config.connectHref}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Connect {accountLabel} account
          </a>
        )}
        {config.ingestionHref && config.ingestionLabel ? (
          <Link
            href={config.ingestionHref}
            className="text-[12px] text-ink-subtle underline decoration-border underline-offset-2 hover:text-ink"
          >
            {config.ingestionLabel}
          </Link>
        ) : null}
      </div>
    </section>
  );
}

function ToolsSection({
  config,
  pluginState,
  previewState,
  state,
  canEdit,
  permissionConnection,
}: {
  config: OfficialMcpPluginConfig;
  pluginState: PluginLoadState;
  previewState: PluginPreviewState;
  state: PluginToolsState;
  canEdit: boolean;
  permissionConnection: IntegrationAccountView<PluginConnectionProvider> | null;
}) {
  const router = useRouter();
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [isRefreshing, startRefresh] = useTransition();
  const plugin = pluginState.status === "ready" ? pluginState.plugin : null;
  const displayedState = plugin
    ? state
    : previewState.status === "ready"
      ? officialPluginToolsStateFromPreview(previewState.preview, config.name)
      : previewState;

  const refresh = () => {
    if (!plugin || plugin.status !== "enabled" || isRefreshing) return;
    setRefreshError(null);
    startRefresh(async () => {
      try {
        const refreshed = await refreshHeadlessPluginMcp(plugin.name);
        const discoveryError = refreshed.remoteMcpServers.find(
          (server: PluginRemoteMcpServerDto) => server.lastDiscoveryError,
        )?.lastDiscoveryError;
        if (discoveryError) {
          setRefreshError(discoveryError);
          if (!isConnectionRequiredError(discoveryError)) {
            toast.error(`${config.label} tool discovery failed.`);
          }
        } else {
          toast.success(`${config.label} tools refreshed.`);
        }
        router.refresh();
      } catch (cause) {
        setRefreshError(errorMessage(cause));
      }
    });
  };
  const headingId = `${config.name}-tools-heading`;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeading
        id={headingId}
        icon={Wrench}
        title="Tools"
        description={`Choose whether ${config.label} capabilities run automatically, ask first, or stay unavailable.`}
      />
      {pluginState.status === "loading" ? (
        <SectionSkeleton label={`Loading ${config.label} tools`} rows={2} />
      ) : pluginState.status === "error" ? (
        <SectionError title="Tools unavailable" message={pluginState.message} />
      ) : displayedState.status === "loading" ? (
        <SectionSkeleton
          label={
            plugin ? `Discovering ${config.label} tools` : `Loading ${config.label} tool preview`
          }
          rows={2}
        />
      ) : displayedState.status === "error" ? (
        <SectionError title="Tools unavailable" message={displayedState.message} />
      ) : (
        <>
          {plugin ? (
            <DiscoveryStatus
              pluginLabel={config.label}
              discovery={displayedState.discovery}
              needsConnection={isConnectionRequiredError(
                refreshError ?? displayedState.discovery.lastDiscoveryError,
              )}
              canRefresh={canEdit && plugin.status === "enabled"}
              isRefreshing={isRefreshing}
              onRefresh={refresh}
            />
          ) : (
            <p className="text-[12px] leading-4 text-ink-subtle">
              Package preview · permission modes become editable after installation and account
              connection.
            </p>
          )}
          {refreshError && !isConnectionRequiredError(refreshError) ? (
            <SectionError title="Discovery refresh failed" message={refreshError} />
          ) : displayedState.discovery.lastDiscoveryError &&
            !isConnectionRequiredError(displayedState.discovery.lastDiscoveryError) ? (
            <Alert
              variant={displayedState.discovery.status === "stale" ? "warning" : "destructive"}
            >
              <AlertCircle />
              <AlertTitle>Discovery refresh failed</AlertTitle>
              <AlertDescription>
                {displayedState.discovery.lastDiscoveryError}
                {displayedState.discovery.status === "stale"
                  ? " The last successful tool snapshot remains available below."
                  : ""}
              </AlertDescription>
            </Alert>
          ) : null}
          {displayedState.groups.every((group) => group.tools.length === 0) ? (
            <SectionEmpty icon={Wrench}>
              {isConnectionRequiredError(
                refreshError ?? displayedState.discovery.lastDiscoveryError,
              )
                ? `Connect a ${config.label} account to activate tools.`
                : displayedState.discovery.status === "error"
                  ? `No ${config.label} tools are available because discovery has not succeeded yet.`
                  : "No tools have been discovered yet. Capability permissions are ready and will apply when discovery completes."}
            </SectionEmpty>
          ) : null}
          <div className="flex flex-col gap-2">
            {displayedState.groups.map((group) => (
              <ToolGroupCard
                key={group.id}
                group={group}
                provider={config.connectionProvider}
                permissionConnection={plugin ? permissionConnection : null}
              />
            ))}
          </div>
          {plugin && !permissionConnection ? (
            <p className="text-[12px] leading-4 text-ink-subtle">
              {config.name === "infisical"
                ? "Documentation reads stay On and documentation feedback stays Off. Secret access uses the permission-gated sandbox CLI workflow."
                : `Connect a ${config.label} account to change permission modes.`}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function DiscoveryStatus({
  pluginLabel,
  discovery,
  needsConnection,
  canRefresh,
  isRefreshing,
  onRefresh,
}: {
  pluginLabel: string;
  discovery: Extract<PluginToolsState, { status: "ready" }>["discovery"];
  needsConnection: boolean;
  canRefresh: boolean;
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  const status = needsConnection
    ? { label: "Needs account", variant: "outline" as const }
    : {
        pending: { label: "Pending", variant: "outline" as const },
        ready: { label: "Ready", variant: "success" as const },
        stale: { label: "Stale", variant: "warning" as const },
        error: { label: "Failed", variant: "destructive" as const },
      }[discovery.status];
  const summary = needsConnection
    ? `Connect a ${pluginLabel} account to activate tools.`
    : discovery.discoveredAt
      ? `${discovery.toolCount} ${discovery.toolCount === 1 ? "tool" : "tools"} discovered ${formatDateTime(discovery.discoveredAt)}`
      : "Waiting for the first successful discovery.";

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-muted px-3 py-2.5">
      <Badge variant={status.variant}>{status.label}</Badge>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] leading-4 text-ink">{summary}</p>
        {discovery.refreshAfter ? (
          <p className="mt-0.5 text-[11px] leading-4 text-ink-faint">
            Next automatic attempt {formatDateTime(discovery.refreshAfter)}
          </p>
        ) : null}
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={!canRefresh || isRefreshing}
        onClick={onRefresh}
      >
        {isRefreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        Refresh
      </Button>
    </div>
  );
}

function ToolGroupCard({
  group,
  provider,
  permissionConnection,
}: {
  group: PluginToolGroupView;
  provider: string;
  permissionConnection: IntegrationAccountView<PluginConnectionProvider> | null;
}) {
  return (
    <Card className="gap-3 bg-surface py-3 shadow-none">
      <CardHeader className="grid-cols-[minmax(0,1fr)_auto] px-3">
        <div className="min-w-0">
          <CardTitle className="text-[13px] font-medium leading-5 text-ink">
            {group.label}
          </CardTitle>
          <p className="text-[12px] leading-4 text-ink-subtle">{group.description}</p>
        </div>
        <PluginCapabilityModeRow
          group={group}
          provider={provider}
          connection={permissionConnection}
        />
      </CardHeader>
      {group.tools.length > 0 ? (
        <CardContent className="px-3">
          <details className="group rounded-md border border-border/70">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[12px] font-medium text-ink-muted">
              {group.tools.length} {group.tools.length === 1 ? "tool" : "tools"}
              <ChevronDown className="ml-auto size-3.5 transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-border/70 p-2">
              <ToolRows tools={group.tools} />
            </div>
          </details>
        </CardContent>
      ) : null}
    </Card>
  );
}

function PluginCapabilityModeRow({
  group,
  provider,
  connection,
}: {
  group: PluginToolGroupView;
  provider: string;
  connection: IntegrationAccountView<PluginConnectionProvider> | null;
}) {
  const router = useRouter();
  const [pendingMode, setPendingMode] = useState<CapabilityMode | null>(null);
  const [isPending, startTransition] = useTransition();
  const storedModes = connection?.capabilityModes;
  const hasStoredMode =
    storedModes !== null &&
    typeof storedModes === "object" &&
    !Array.isArray(storedModes) &&
    Object.hasOwn(storedModes, group.modeKey);
  const mode =
    pendingMode ??
    effectiveCapabilityMode(
      connection?.provider ?? provider,
      group.modeKey,
      hasStoredMode ? storedModes : { [group.modeKey]: group.defaultMode },
    );

  const select = (nextMode: CapabilityMode) => {
    if (!connection || isPending || nextMode === mode) return;
    setPendingMode(nextMode);
    startTransition(async () => {
      const result = await setIntegrationCapabilityModeAction(
        connection.integrationId,
        group.modeKey,
        nextMode,
      );
      if (!result.ok) {
        setPendingMode(null);
        toast.error(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <CapabilityModeToggle
      label={group.label}
      mode={mode}
      disabled={!connection || isPending}
      onChange={select}
    />
  );
}

function ToolRows({ tools }: { tools: PluginToolView[] }) {
  return (
    <ul className="overflow-hidden rounded-md border border-border/70">
      {tools.map((tool) => (
        <li key={tool.id} className="border-b border-border/70 px-3 py-2 last:border-b-0">
          <p className="text-[12px] font-medium leading-4 text-ink">{tool.name}</p>
          {tool.description ? (
            <p className="mt-0.5 text-[11.5px] leading-4 text-ink-subtle">{tool.description}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function SkillsSection({
  config,
  state,
  previewState,
}: {
  config: OfficialMcpPluginConfig;
  state: PluginLoadState;
  previewState: PluginPreviewState;
}) {
  const plugin = state.status === "ready" ? state.plugin : null;
  const skills: PluginSkill[] = plugin
    ? plugin.skills.map((skill: { bundleId: string; name: string; description: string }) => ({
        id: skill.bundleId,
        name: skill.name,
        description: skill.description,
      }))
    : previewState.status === "ready"
      ? previewState.preview.skills.map(
          (skill: { integrity: string; name: string; description: string }) => ({
            id: skill.integrity,
            name: skill.name,
            description: skill.description,
          }),
        )
      : [];
  const headingId = `${config.name}-skills-heading`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeading
        id={headingId}
        icon={Sparkles}
        title="Skills"
        description="Workflows supplied by the integrity-pinned plugin package."
      />
      {state.status === "loading" ? (
        <SectionSkeleton label={`Loading ${config.label} skills`} rows={2} compact />
      ) : state.status === "error" ? (
        <SectionError title="Skills unavailable" message={state.message} />
      ) : !plugin && previewState.status === "loading" ? (
        <SectionSkeleton label={`Loading ${config.label} skill preview`} rows={2} compact />
      ) : !plugin && previewState.status === "error" ? (
        <SectionError title="Skills unavailable" message={previewState.message} />
      ) : skills.length === 0 ? (
        <SectionEmpty icon={Sparkles}>This version of the plugin contains no skills.</SectionEmpty>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border bg-surface">
          {skills.map((skill) => (
            <li key={skill.id} className="border-b border-border px-3 py-2.5 last:border-b-0">
              <div className="flex items-center gap-2">
                <Sparkles className="size-3.5 shrink-0 text-ink-subtle" />
                <span className="text-[13px] font-medium text-ink">{skill.name}</span>
              </div>
              <p className="mt-1 text-[12px] leading-4 text-ink-subtle">{skill.description}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SectionHeading({
  id,
  icon: Icon,
  title,
  description,
}: {
  id: string;
  icon: typeof Wrench;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
      <div>
        <h2 id={id} className="text-[13px] font-semibold leading-5 text-ink">
          {title}
        </h2>
        <p className="text-[12px] leading-4 text-ink-subtle">{description}</p>
      </div>
    </div>
  );
}

function SectionSkeleton({
  label,
  rows,
  compact = false,
}: {
  label: string;
  rows: number;
  compact?: boolean;
}) {
  return (
    <div aria-label={label} className="flex flex-col gap-2 rounded-lg border border-border p-3">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={`${label}-${index}`} className={compact ? "h-9 w-full" : "h-16 w-full"} />
      ))}
    </div>
  );
}

function SectionError({ title, message }: { title: string; message: string }) {
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function SectionEmpty({ icon: Icon, children }: { icon: typeof Wrench; children: string }) {
  return (
    <Card className="gap-0 bg-surface py-0 shadow-none">
      <CardContent className="flex items-center gap-2.5 px-3 py-3 text-[12.5px] leading-5 text-ink-subtle">
        <Icon className="size-4 shrink-0 text-ink-faint" />
        <span>{children}</span>
      </CardContent>
    </Card>
  );
}

function pluginAccountsFromState(
  state: IntegrationState,
  config: OfficialMcpPluginConfig,
): {
  accounts: PluginAccount[];
  permissionConnection: IntegrationAccountView<PluginConnectionProvider> | null;
  workspaceInfisical?: InfisicalProviderState;
} {
  if (config.connectionProvider === "infisical") {
    return {
      accounts: [],
      permissionConnection: null,
      workspaceInfisical: state.infisical,
    };
  }
  if (config.connectionProvider === "granola") {
    const connection = state.granola_mcp;
    const permissionConnection: IntegrationAccountView<"granola"> | null = connection.integrationId
      ? {
          integrationId: connection.integrationId,
          provider: "granola",
          status: connection.status === "not_connected" ? "disconnected" : connection.status,
          connected: connection.connected,
          accountEmail: null,
          accountName: connection.accountName,
          connectionLabel: connection.accountName || "Granola tool access",
          statusReason: connection.statusReason,
          scopes: [],
          capabilityModes: connection.capabilityModes,
        }
      : null;
    return {
      permissionConnection,
      accounts: permissionConnection ? [{ account: permissionConnection }] : [],
    };
  }
  if (
    config.connectionProvider === "attio" ||
    config.connectionProvider === "betterstack" ||
    config.connectionProvider === "fathom" ||
    config.connectionProvider === "github_user" ||
    config.connectionProvider === "gmail" ||
    config.connectionProvider === "google_calendar" ||
    config.connectionProvider === "google_drive" ||
    config.connectionProvider === "hubspot" ||
    config.connectionProvider === "jamie" ||
    config.connectionProvider === "neon" ||
    config.connectionProvider === "posthog" ||
    config.connectionProvider === "render" ||
    config.connectionProvider === "vercel" ||
    config.connectionProvider === "signoz" ||
    config.connectionProvider === "slack" ||
    config.connectionProvider === "stripe" ||
    config.connectionProvider === "x_account"
  ) {
    if (config.connectionProvider === "stripe") {
      const connection = state.stripe;
      const modeLabel =
        connection.livemode === false
          ? "Test mode"
          : connection.livemode === true
            ? "Live mode"
            : null;
      const permissionConnection: IntegrationAccountView<"stripe"> | null = connection.integrationId
        ? {
            integrationId: connection.integrationId,
            provider: "stripe",
            status: connection.status === "not_connected" ? "disconnected" : connection.status,
            connected: connection.connected,
            accountEmail: null,
            accountName: connection.accountName,
            connectionLabel: [connection.accountName, modeLabel].filter(Boolean).join(" · "),
            statusReason: connection.statusReason,
            scopes: [],
            capabilityModes: connection.capabilityModes,
          }
        : null;
      return {
        permissionConnection,
        accounts: permissionConnection ? [{ account: permissionConnection }] : [],
      };
    }
    if (
      config.connectionProvider === "attio" ||
      config.connectionProvider === "posthog" ||
      config.connectionProvider === "hubspot"
    ) {
      const provider = config.connectionProvider;
      const connection = state[provider];
      const permissionConnection: IntegrationAccountView<typeof provider> | null =
        connection.integrationId
          ? {
              integrationId: connection.integrationId,
              provider,
              status: connection.status === "not_connected" ? "disconnected" : connection.status,
              connected: connection.connected,
              accountEmail: null,
              accountName: connection.accountName,
              connectionLabel:
                connection.accountName ||
                `${provider === "attio" ? "Attio" : provider === "hubspot" ? "HubSpot" : "PostHog"} tool access`,
              statusReason: connection.statusReason,
              scopes: [],
              capabilityModes: connection.capabilityModes,
            }
          : null;
      return {
        permissionConnection,
        accounts: permissionConnection ? [{ account: permissionConnection }] : [],
      };
    }
    const accounts = state.personalAccounts[config.connectionProvider].map((account) => ({
      account:
        config.connectionProvider === "google_drive" &&
        account.status === "connected" &&
        !googleDriveMcpScopesSatisfied(account.scopes)
          ? {
              ...account,
              status: "needs_reauth" as const,
              connected: false,
              statusReason: GOOGLE_DRIVE_MCP_RECONNECT_REASON,
            }
          : account,
    }));
    const primaryIntegrationId =
      config.connectionProvider === "gmail"
        ? state.gmail.integrationId
        : config.connectionProvider === "slack"
          ? state.slack.integrationId
          : config.connectionProvider === "google_calendar"
            ? state.google_calendar.integrationId
            : config.connectionProvider === "google_drive"
              ? state.google_drive.integrationId
              : config.connectionProvider === "x_account"
                ? state.x_account.integrationId
                : config.connectionProvider === "jamie"
                  ? state.jamie.integrationId
                  : null;
    return {
      accounts,
      permissionConnection:
        accounts.find(({ account }) => account.integrationId === primaryIntegrationId)?.account ??
        accounts.find(({ account }) => account.connected)?.account ??
        accounts[0]?.account ??
        null,
    };
  }
  const permissionConnection: IntegrationAccountView<"linear"> | null = state.linear.integrationId
    ? {
        integrationId: state.linear.integrationId,
        provider: "linear",
        status: state.linear.status === "not_connected" ? "disconnected" : state.linear.status,
        connected: state.linear.connected,
        accountEmail: null,
        accountName: state.linear.accountName,
        connectionLabel: state.linear.accountName || "Linear tool access",
        statusReason: state.linear.statusReason,
        scopes: [],
        capabilityModes: state.linear.capabilityModes,
      }
    : null;
  return {
    permissionConnection,
    accounts: permissionConnection ? [{ account: permissionConnection }] : [],
  };
}

export function defaultLinearToolsState(): PluginToolsState {
  return defaultOfficialPluginToolsState("linear");
}

export function defaultAttioToolsState(): PluginToolsState {
  return defaultOfficialPluginToolsState("attio");
}

export function defaultGitHubToolsState(): PluginToolsState {
  return defaultOfficialPluginToolsState("github");
}

export function defaultGmailToolsState(): PluginToolsState {
  return defaultOfficialPluginToolsState("gmail");
}

export function defaultGranolaToolsState(): PluginToolsState {
  return defaultOfficialPluginToolsState("granola");
}

export function defaultGoogleCalendarToolsState(): PluginToolsState {
  return defaultOfficialPluginToolsState("google-calendar");
}

export function defaultGoogleDriveToolsState(): PluginToolsState {
  return defaultOfficialPluginToolsState("google-drive");
}

export function defaultHubSpotToolsState(): PluginToolsState {
  return defaultOfficialPluginToolsState("hubspot");
}

export function defaultInfisicalToolsState(): PluginToolsState {
  return defaultOfficialPluginToolsState("infisical");
}

export function defaultLatitudeToolsState(): PluginToolsState {
  return defaultOfficialPluginToolsState("latitude");
}

export function defaultNeonToolsState(): PluginToolsState {
  return defaultOfficialPluginToolsState("neon");
}

export function defaultBetterStackToolsState(): PluginToolsState {
  return defaultOfficialPluginToolsState("betterstack");
}

export function defaultFathomToolsState(): PluginToolsState {
  return defaultOfficialPluginToolsState("fathom");
}

export function defaultPostHogToolsState(): PluginToolsState {
  return defaultOfficialPluginToolsState("posthog");
}

export function defaultSlackToolsState(): PluginToolsState {
  return defaultOfficialPluginToolsState("slack");
}

export function defaultStripeToolsState(): PluginToolsState {
  return defaultOfficialPluginToolsState("stripe");
}

export function defaultSigNozToolsState(): PluginToolsState {
  return defaultOfficialPluginToolsState("signoz");
}

export function defaultVercelToolsState(): PluginToolsState {
  return defaultOfficialPluginToolsState("vercel");
}

function defaultOfficialPluginToolsState(provider: OfficialMcpPluginName): PluginToolsState {
  return {
    status: "ready",
    groups: providerCapabilities(OFFICIAL_MCP_PLUGINS[provider].connectionProvider).map(
      (capability) => ({
        id: capability.id,
        label: capability.label,
        description: capability.description,
        modeKey: capability.id,
        defaultMode: capability.defaultMode,
        curated: true,
        tools: [],
      }),
    ),
    discovery: {
      status: "pending",
      toolCount: 0,
      discoveredAt: null,
      refreshAfter: null,
      lastDiscoveryError: null,
    },
  };
}

export function linearToolsStateFromPlugin(plugin: PluginInstallationDto | null): PluginToolsState {
  return officialPluginToolsStateFromPlugin(plugin, "linear");
}

export function attioToolsStateFromPlugin(plugin: PluginInstallationDto | null): PluginToolsState {
  return officialPluginToolsStateFromPlugin(plugin, "attio");
}

export function githubToolsStateFromPlugin(plugin: PluginInstallationDto | null): PluginToolsState {
  return officialPluginToolsStateFromPlugin(plugin, "github");
}

export function gmailToolsStateFromPlugin(plugin: PluginInstallationDto | null): PluginToolsState {
  return officialPluginToolsStateFromPlugin(plugin, "gmail");
}

export function granolaToolsStateFromPlugin(
  plugin: PluginInstallationDto | null,
): PluginToolsState {
  return officialPluginToolsStateFromPlugin(plugin, "granola");
}

export function googleCalendarToolsStateFromPlugin(
  plugin: PluginInstallationDto | null,
): PluginToolsState {
  return officialPluginToolsStateFromPlugin(plugin, "google-calendar");
}

export function googleDriveToolsStateFromPlugin(
  plugin: PluginInstallationDto | null,
): PluginToolsState {
  return officialPluginToolsStateFromPlugin(plugin, "google-drive");
}

export function hubspotToolsStateFromPlugin(
  plugin: PluginInstallationDto | null,
): PluginToolsState {
  return officialPluginToolsStateFromPlugin(plugin, "hubspot");
}

export function latitudeToolsStateFromPlugin(
  plugin: PluginInstallationDto | null,
): PluginToolsState {
  return officialPluginToolsStateFromPlugin(plugin, "latitude");
}

export function neonToolsStateFromPlugin(plugin: PluginInstallationDto | null): PluginToolsState {
  return officialPluginToolsStateFromPlugin(plugin, "neon");
}

export function betterStackToolsStateFromPlugin(
  plugin: PluginInstallationDto | null,
): PluginToolsState {
  return officialPluginToolsStateFromPlugin(plugin, "betterstack");
}

export function slackToolsStateFromPlugin(plugin: PluginInstallationDto | null): PluginToolsState {
  return officialPluginToolsStateFromPlugin(plugin, "slack");
}

export function signozToolsStateFromPlugin(plugin: PluginInstallationDto | null): PluginToolsState {
  return officialPluginToolsStateFromPlugin(plugin, "signoz");
}

export function posthogToolsStateFromPlugin(
  plugin: PluginInstallationDto | null,
): PluginToolsState {
  return officialPluginToolsStateFromPlugin(plugin, "posthog");
}

export function stripeToolsStateFromPlugin(plugin: PluginInstallationDto | null): PluginToolsState {
  return officialPluginToolsStateFromPlugin(plugin, "stripe");
}

function officialPluginToolsStateFromPlugin(
  plugin: PluginInstallationDto | null,
  provider: OfficialMcpPluginName,
): PluginToolsState {
  if (!plugin?.remoteMcpServers.length) return defaultOfficialPluginToolsState(provider);

  const definitions = new Map<CapabilityId, PluginRemoteMcpServerDto["capabilities"][number]>();
  const tools: Array<
    PluginToolView & {
      capabilityId: CapabilityId;
      capabilityLabel: string;
      defaultMode: CapabilityMode;
      curated: boolean;
    }
  > = [];
  for (const server of plugin.remoteMcpServers) {
    for (const definition of server.capabilities) definitions.set(definition.id, definition);
    for (const tool of server.tools) {
      tools.push({
        id: `${server.name}:${tool.name}`,
        name: displayToolName(tool.name),
        description: tool.description?.trim() || null,
        readOnly: tool.classification.bucket === "read",
        capabilityId: tool.classification.capabilityId,
        capabilityLabel: tool.classification.capabilityLabel,
        defaultMode: tool.classification.defaultMode,
        curated: tool.classification.curated,
      });
    }
  }

  const knownCapabilities = providerCapabilities(OFFICIAL_MCP_PLUGINS[provider].connectionProvider);
  const curatedGroups = [...definitions.values()].map((definition) => ({
    id: definition.id,
    label: definition.label,
    description:
      officialCapabilityDescription(provider, definition.id) ??
      knownCapabilities.find((capability) => capability.id === definition.id)?.description ??
      `${definition.label} tools supplied by the installed plugin.`,
    modeKey: definition.id,
    defaultMode: definition.defaultMode,
    curated: true,
    tools: tools.filter(
      (tool) => tool.curated && tool.capabilityId === definition.id,
    ) as PluginToolView[],
  }));
  const uncuratedGroups = uncuratedPluginToolGroups(tools.filter((tool) => !tool.curated)).filter(
    (group) => group.tools.length > 0,
  );
  const servers = plugin.remoteMcpServers;
  const lastDiscoveryError = servers
    .flatMap((server: PluginRemoteMcpServerDto) =>
      server.lastDiscoveryError ? [server.lastDiscoveryError] : [],
    )
    .filter((value: string, index: number, values: string[]) => values.indexOf(value) === index)
    .join(" ");

  return {
    status: "ready",
    groups: [...curatedGroups, ...uncuratedGroups],
    discovery: {
      status: aggregateDiscoveryStatus(
        servers.map((server: PluginRemoteMcpServerDto) => server.discoveryStatus),
      ),
      toolCount: tools.length,
      discoveredAt: latestTimestamp(
        servers.map((server: PluginRemoteMcpServerDto) => server.discoveredAt),
      ),
      refreshAfter: earliestTimestamp(
        servers.map((server: PluginRemoteMcpServerDto) => server.refreshAfter),
      ),
      lastDiscoveryError: lastDiscoveryError || null,
    },
  };
}

export function linearToolsStateFromPreview(preview: PluginImportPreviewDto): PluginToolsState {
  return officialPluginToolsStateFromPreview(preview, "linear");
}

export function attioToolsStateFromPreview(preview: PluginImportPreviewDto): PluginToolsState {
  return officialPluginToolsStateFromPreview(preview, "attio");
}

export function githubToolsStateFromPreview(preview: PluginImportPreviewDto): PluginToolsState {
  return officialPluginToolsStateFromPreview(preview, "github");
}

export function gmailToolsStateFromPreview(preview: PluginImportPreviewDto): PluginToolsState {
  return officialPluginToolsStateFromPreview(preview, "gmail");
}

export function granolaToolsStateFromPreview(preview: PluginImportPreviewDto): PluginToolsState {
  return officialPluginToolsStateFromPreview(preview, "granola");
}

export function googleCalendarToolsStateFromPreview(
  preview: PluginImportPreviewDto,
): PluginToolsState {
  return officialPluginToolsStateFromPreview(preview, "google-calendar");
}

export function googleDriveToolsStateFromPreview(
  preview: PluginImportPreviewDto,
): PluginToolsState {
  return officialPluginToolsStateFromPreview(preview, "google-drive");
}

export function neonToolsStateFromPreview(preview: PluginImportPreviewDto): PluginToolsState {
  return officialPluginToolsStateFromPreview(preview, "neon");
}

export function betterStackToolsStateFromPreview(
  preview: PluginImportPreviewDto,
): PluginToolsState {
  return officialPluginToolsStateFromPreview(preview, "betterstack");
}

export function slackToolsStateFromPreview(preview: PluginImportPreviewDto): PluginToolsState {
  return officialPluginToolsStateFromPreview(preview, "slack");
}

export function signozToolsStateFromPreview(preview: PluginImportPreviewDto): PluginToolsState {
  return officialPluginToolsStateFromPreview(preview, "signoz");
}

export function posthogToolsStateFromPreview(preview: PluginImportPreviewDto): PluginToolsState {
  return officialPluginToolsStateFromPreview(preview, "posthog");
}

export function hubspotToolsStateFromPreview(preview: PluginImportPreviewDto): PluginToolsState {
  return officialPluginToolsStateFromPreview(preview, "hubspot");
}

export function latitudeToolsStateFromPreview(preview: PluginImportPreviewDto): PluginToolsState {
  return officialPluginToolsStateFromPreview(preview, "latitude");
}

export function stripeToolsStateFromPreview(preview: PluginImportPreviewDto): PluginToolsState {
  return officialPluginToolsStateFromPreview(preview, "stripe");
}

function officialPluginToolsStateFromPreview(
  preview: PluginImportPreviewDto,
  provider: OfficialMcpPluginName,
): PluginToolsState {
  const knownCapabilities = providerCapabilities(OFFICIAL_MCP_PLUGINS[provider].connectionProvider);
  const definitions = new Map<CapabilityId, PluginToolGroupView>();
  for (const server of preview.remoteMcpServers) {
    for (const capability of server.capabilities) {
      definitions.set(capability.id, {
        id: capability.id,
        label: capability.label,
        description:
          officialCapabilityDescription(provider, capability.id) ??
          knownCapabilities.find((known) => known.id === capability.id)?.description ??
          `${capability.label} tools supplied by the official package.`,
        modeKey: capability.id,
        defaultMode: capability.defaultMode,
        curated: true,
        tools: capability.tools.map((tool: string) => ({
          id: `${server.name}:${tool}`,
          name: displayToolName(tool),
          description: null,
          readOnly: capability.id === "read" || capability.id === "query",
        })),
      });
    }
  }
  return {
    status: "ready",
    groups: [...definitions.values()],
    discovery: {
      status: "pending",
      toolCount: [...definitions.values()].reduce((total, group) => total + group.tools.length, 0),
      discoveredAt: null,
      refreshAfter: null,
      lastDiscoveryError: null,
    },
  };
}

function officialCapabilityDescription(
  provider: OfficialMcpPluginName,
  capabilityId: CapabilityId,
): string | null {
  if (provider === "gmail" && capabilityId === "write") {
    return "Add or remove labels, create labels, move mail to trash, and mark or unmark spam.";
  }
  return null;
}

export function uncuratedPluginToolGroups(tools: readonly PluginToolView[]): PluginToolGroupView[] {
  return [
    {
      id: "uncurated-read",
      label: "Read tools",
      description: "Tools the server marks as read-only. Uncurated tools ask by default.",
      modeKey: "read",
      defaultMode: "ask",
      curated: false,
      tools: tools.filter((tool) => tool.readOnly),
    },
    {
      id: "uncurated-write-other",
      label: "Write & other tools",
      description: "Write-capable and unclassified tools. These always ask by default.",
      modeKey: "write",
      defaultMode: "ask",
      curated: false,
      tools: tools.filter((tool) => !tool.readOnly),
    },
  ];
}

function pinnedSourceUrl(plugin: PluginInstallationDto) {
  const path = plugin.source.path
    .split("/")
    .filter(Boolean)
    .map((segment: string) => encodeURIComponent(segment))
    .join("/");
  return `${plugin.source.url}/tree/${plugin.source.resolvedCommit}${path ? `/${path}` : ""}`;
}

function isConnectionRequiredError(value: string | null | undefined) {
  return value?.trim() === NO_CONNECTION_DISCOVERY_ERROR;
}

function aggregateDiscoveryStatus(statuses: PluginRemoteMcpServerDto["discoveryStatus"][]) {
  if (statuses.includes("error")) return "error" as const;
  if (statuses.includes("stale")) return "stale" as const;
  if (statuses.includes("pending")) return "pending" as const;
  return "ready" as const;
}

function latestTimestamp(values: Array<string | null>) {
  return (
    values
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null
  );
}

function earliestTimestamp(values: string[]) {
  return [...values].sort().at(0) ?? null;
}

function displayToolName(value: string) {
  const words = value.replaceAll(/[._-]+/gu, " ").trim();
  return words ? `${words.slice(0, 1).toLocaleUpperCase()}${words.slice(1)}` : value;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : "Something went wrong.";
}
