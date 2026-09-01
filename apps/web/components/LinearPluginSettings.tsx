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
import { LinearIcon } from "@opencompany/ui/icons";
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
import { installOfficialLinearPlugin, LINEAR_PLUGIN_SOURCE } from "@/components/PluginSettings";
import { SettingsContent } from "@/components/SettingsChrome";
import {
  IntegrationAccountRow,
  IntegrationSetupFeedback,
} from "@/components/SettingsIntegrationsPanel";
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
import { type IntegrationAccountView, type IntegrationState } from "@/lib/integration-state";

const LINEAR_DESCRIPTION = "Work with Linear issues, projects, comments, and team workflows.";
const LINEAR_TOOLS_CONNECT_HREF =
  "/api/integrations/linear/start?returnTo=/settings/plugins/linear";
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

type LinearAccount = { account: IntegrationAccountView };

type LinearPluginSkill = {
  id: string;
  name: string;
  description: string;
};

type PluginPreviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; preview: PluginImportPreviewDto };

export type LinearAccountsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      accounts: LinearAccount[];
      permissionConnection: IntegrationAccountView | null;
    };

export function LinearPluginDetail({
  pluginState,
  canEdit,
  toolsState,
}: {
  pluginState: PluginLoadState;
  canEdit: boolean;
  toolsState?: PluginToolsState;
}) {
  const { integrations } = useAppData();
  const accountsState = useMemo<LinearAccountsState>(
    () => ({ status: "ready", ...linearAccountsFromState(integrations) }),
    [integrations],
  );
  const effectiveToolsState =
    toolsState ??
    (pluginState.status === "loading"
      ? { status: "loading" as const }
      : pluginState.status === "error"
        ? { status: "error" as const, message: pluginState.message }
        : linearToolsStateFromPlugin(pluginState.plugin));

  return (
    <LinearPluginDetailView
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
  const plugin = pluginState.status === "ready" ? pluginState.plugin : null;
  const shouldPreview = pluginState.status === "ready" && !pluginState.plugin;
  const [previewState, setPreviewState] = useState<PluginPreviewState>({ status: "loading" });

  useEffect(() => {
    if (!shouldPreview) return;
    let active = true;
    void previewHeadlessPluginImport({ url: LINEAR_PLUGIN_SOURCE })
      .then((preview) => {
        if (active) setPreviewState({ status: "ready", preview });
      })
      .catch((cause) => {
        if (active) setPreviewState({ status: "error", message: errorMessage(cause) });
      });
    return () => {
      active = false;
    };
  }, [shouldPreview]);

  return (
    <>
      <IntegrationSetupFeedback />
      <SettingsContent
        title={plugin?.manifest.name || "Linear"}
        description={plugin?.manifest.description || LINEAR_DESCRIPTION}
        backLink={{ href: "/settings/plugins", label: "Plugins" }}
      >
        <PluginHeaderSection state={pluginState} previewState={previewState} canEdit={canEdit} />
        {plugin ? <AccountsSection state={accountsState} /> : null}
        <ToolsSection
          pluginState={pluginState}
          previewState={previewState}
          state={toolsState}
          canEdit={canEdit}
          permissionConnection={
            accountsState.status === "ready" ? accountsState.permissionConnection : null
          }
        />
        <SkillsSection state={pluginState} previewState={previewState} />
      </SettingsContent>
    </>
  );
}

function PluginHeaderSection({
  state,
  previewState,
  canEdit,
}: {
  state: PluginLoadState;
  previewState: PluginPreviewState;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (state.status === "loading") return <SectionSkeleton label="Loading Linear plugin" rows={2} />;
  if (state.status === "error") {
    return <SectionError title="Plugin details unavailable" message={state.message} />;
  }

  const plugin = state.plugin;
  const install = () => {
    if (plugin || isPending) return;
    setError(null);
    startTransition(async () => {
      try {
        await installOfficialLinearPlugin(
          previewState.status === "ready" ? previewState.preview : undefined,
        );
        router.refresh();
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  };
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
        <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-[#5E6AD2] text-white">
          <LinearIcon className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="plugin-overview-heading" className="text-[15px] font-semibold text-ink">
              Linear
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
            {plugin?.manifest.description || LINEAR_DESCRIPTION}
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
              <Button size="sm" disabled={isPending} onClick={install}>
                {isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <PlugZap className="size-3.5" />
                )}
                {isPending ? "Installing…" : "Install"}
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
            <DialogTitle className="text-[15px]">Uninstall Linear?</DialogTitle>
            <DialogDescription className="text-[12.5px] leading-5 text-ink-subtle">
              Linear tools and plugin skills will be removed. Connected accounts and ongoing
              ingestion will not be changed.
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

function AccountsSection({ state }: { state: LinearAccountsState }) {
  const permissionConnection = state.status === "ready" ? state.permissionConnection : null;

  return (
    <section aria-labelledby="linear-accounts-heading" className="flex flex-col gap-3">
      <SectionHeading
        id="linear-accounts-heading"
        icon={Users}
        title="Accounts"
        description="The account opencompany uses when you run Linear tools."
      />
      {state.status === "loading" ? (
        <SectionSkeleton label="Loading Linear accounts" rows={2} compact />
      ) : state.status === "error" ? (
        <SectionError title="Accounts unavailable" message={state.message} />
      ) : !permissionConnection ? (
        <SectionEmpty icon={Users}>No Linear accounts are connected.</SectionEmpty>
      ) : (
        <div className="flex flex-col gap-2">
          <IntegrationAccountRow
            account={permissionConnection}
            purposeLabel="Linear"
            showCapabilityModes={false}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <a
          href={LINEAR_TOOLS_CONNECT_HREF}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Connect Linear account
        </a>
        <Link
          href="/wiki/sources"
          className="text-[12px] text-ink-subtle underline decoration-border underline-offset-2 hover:text-ink"
        >
          Configure Linear ingestion in Wiki sources
        </Link>
      </div>
    </section>
  );
}

function ToolsSection({
  pluginState,
  previewState,
  state,
  canEdit,
  permissionConnection,
}: {
  pluginState: PluginLoadState;
  previewState: PluginPreviewState;
  state: PluginToolsState;
  canEdit: boolean;
  permissionConnection: IntegrationAccountView | null;
}) {
  const router = useRouter();
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [isRefreshing, startRefresh] = useTransition();
  const plugin = pluginState.status === "ready" ? pluginState.plugin : null;
  const displayedState = plugin
    ? state
    : previewState.status === "ready"
      ? linearToolsStateFromPreview(previewState.preview)
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
            toast.error("Linear tool discovery failed.");
          }
        } else {
          toast.success("Linear tools refreshed.");
        }
        router.refresh();
      } catch (cause) {
        setRefreshError(errorMessage(cause));
      }
    });
  };

  return (
    <section aria-labelledby="linear-tools-heading" className="flex flex-col gap-3">
      <SectionHeading
        id="linear-tools-heading"
        icon={Wrench}
        title="Tools"
        description="Choose whether Linear capabilities run automatically, ask first, or stay unavailable."
      />
      {pluginState.status === "loading" ? (
        <SectionSkeleton label="Loading Linear tools" rows={2} />
      ) : pluginState.status === "error" ? (
        <SectionError title="Tools unavailable" message={pluginState.message} />
      ) : displayedState.status === "loading" ? (
        <SectionSkeleton
          label={plugin ? "Discovering Linear tools" : "Loading Linear tool preview"}
          rows={2}
        />
      ) : displayedState.status === "error" ? (
        <SectionError title="Tools unavailable" message={displayedState.message} />
      ) : (
        <>
          {plugin ? (
            <DiscoveryStatus
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
                ? "Connect a Linear account to activate tools."
                : displayedState.discovery.status === "error"
                  ? "No Linear tools are available because discovery has not succeeded yet."
                  : "No tools have been discovered yet. Capability permissions are ready and will apply when discovery completes."}
            </SectionEmpty>
          ) : null}
          <div className="flex flex-col gap-2">
            {displayedState.groups.map((group) => (
              <ToolGroupCard
                key={group.id}
                group={group}
                permissionConnection={plugin ? permissionConnection : null}
              />
            ))}
          </div>
          {plugin && !permissionConnection ? (
            <p className="text-[12px] leading-4 text-ink-subtle">
              Connect a Linear account to change permission modes.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function DiscoveryStatus({
  discovery,
  needsConnection,
  canRefresh,
  isRefreshing,
  onRefresh,
}: {
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
    ? "Connect a Linear account to activate tools."
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
  permissionConnection,
}: {
  group: PluginToolGroupView;
  permissionConnection: IntegrationAccountView | null;
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
        <PluginCapabilityModeRow group={group} connection={permissionConnection} />
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
  connection,
}: {
  group: PluginToolGroupView;
  connection: IntegrationAccountView | null;
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
      connection?.provider ?? "linear",
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
  state,
  previewState,
}: {
  state: PluginLoadState;
  previewState: PluginPreviewState;
}) {
  const plugin = state.status === "ready" ? state.plugin : null;
  const skills: LinearPluginSkill[] = plugin
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
  return (
    <section aria-labelledby="linear-skills-heading" className="flex flex-col gap-3">
      <SectionHeading
        id="linear-skills-heading"
        icon={Sparkles}
        title="Skills"
        description="Read-only workflows supplied by the integrity-pinned plugin package."
      />
      {state.status === "loading" ? (
        <SectionSkeleton label="Loading Linear skills" rows={2} compact />
      ) : state.status === "error" ? (
        <SectionError title="Skills unavailable" message={state.message} />
      ) : !plugin && previewState.status === "loading" ? (
        <SectionSkeleton label="Loading Linear skill preview" rows={2} compact />
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

function linearAccountsFromState(state: IntegrationState): {
  accounts: LinearAccount[];
  permissionConnection: IntegrationAccountView | null;
} {
  const permissionConnection: IntegrationAccountView | null = state.linear.integrationId
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
  return {
    status: "ready",
    groups: providerCapabilities("linear").map((capability) => ({
      id: capability.id,
      label: capability.label,
      description: capability.description,
      modeKey: capability.id,
      defaultMode: capability.defaultMode,
      curated: true,
      tools: [],
    })),
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
  if (!plugin?.remoteMcpServers.length) return defaultLinearToolsState();

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

  const knownCapabilities = providerCapabilities("linear");
  const curatedGroups = [...definitions.values()].map((definition) => ({
    id: definition.id,
    label: definition.label,
    description:
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
  const knownCapabilities = providerCapabilities("linear");
  const definitions = new Map<CapabilityId, PluginToolGroupView>();
  for (const server of preview.remoteMcpServers) {
    for (const capability of server.capabilities) {
      definitions.set(capability.id, {
        id: capability.id,
        label: capability.label,
        description:
          knownCapabilities.find((known) => known.id === capability.id)?.description ??
          `${capability.label} tools supplied by the official package.`,
        modeKey: capability.id,
        defaultMode: capability.defaultMode,
        curated: true,
        tools: capability.tools.map((tool: string) => ({
          id: `${server.name}:${tool}`,
          name: displayToolName(tool),
          description: null,
          readOnly: capability.id === "read",
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
