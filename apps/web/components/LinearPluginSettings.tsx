"use client";

import type { PluginInstallationDto } from "@opencompany/protocol";
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
import { useLiveQuery } from "@tanstack/react-db";
import {
  AlertCircle,
  ChevronDown,
  ExternalLink,
  Loader2,
  PackageCheck,
  PlugZap,
  Sparkles,
  Unplug,
  Users,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { useAppData } from "@/components/AppDataProvider";
import { CapabilityModeToggle } from "@/components/CapabilityModeToggle";
import {
  InstallPluginDialog,
  LINEAR_PLUGIN_NAME,
  LINEAR_PLUGIN_SOURCE,
} from "@/components/PluginSettings";
import { SettingsContent } from "@/components/SettingsChrome";
import { IntegrationAccountRow } from "@/components/SettingsIntegrationsPanel";
import {
  type CapabilityId,
  type CapabilityMode,
  isCapabilityMode,
  providerCapabilities,
} from "@/lib/actions/capabilities";
import {
  getHeadlessIntegrationAccounts,
  type HeadlessIntegrationAccountReadModel,
} from "@/lib/headless-integration-collections";
import { archiveHeadlessPlugin } from "@/lib/headless-knowledge-commands";
import { setIntegrationCapabilityModeAction } from "@/lib/integration-account-actions";
import {
  type IntegrationAccountView,
  type IntegrationState,
  integrationStateFromRows,
} from "@/lib/integration-state";

const LINEAR_DESCRIPTION = "Work with Linear issues, projects, comments, and team workflows.";
const LINEAR_TOOLS_CONNECT_HREF =
  "/api/integrations/linear/start?returnTo=/settings/plugins/linear";
const LINEAR_INGEST_CONNECT_HREF =
  "/api/integrations/linear-ingest/start?returnTo=/settings/plugins/linear";

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
  | { status: "ready"; groups: PluginToolGroupView[] };

type LinearAccount = {
  purpose: "Tools" | "Ingestion";
  account: IntegrationAccountView;
};

type LinearPluginSkill = {
  bundleId: string;
  name: string;
  description: string;
};

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
  const { integrations, workspace } = useAppData();
  const collection = useMemo(() => getHeadlessIntegrationAccounts(workspace.id), [workspace.id]);
  const {
    data: rows,
    isError,
    isLoading,
  } = useLiveQuery((q) => q.from({ integration: collection }), [collection]);

  const initialValue = useMemo(() => linearAccountsFromState(integrations), [integrations]);
  const accountsState = useMemo<LinearAccountsState>(() => {
    if (isError && initialValue.accounts.length === 0) {
      return { status: "error", message: "Linear accounts could not be loaded." };
    }
    if (isLoading && !rows?.length && initialValue.accounts.length === 0) {
      return { status: "loading" };
    }
    if (!rows?.length) return { status: "ready", ...initialValue };
    return {
      status: "ready",
      ...linearAccountsFromState(
        integrationStateFromRows(rows as HeadlessIntegrationAccountReadModel[]),
      ),
    };
  }, [initialValue, isError, isLoading, rows]);
  const effectiveToolsState =
    toolsState ??
    (pluginState.status === "loading"
      ? { status: "loading" as const }
      : pluginState.status === "error"
        ? { status: "error" as const, message: pluginState.message }
        : defaultLinearToolsState());

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

  return (
    <SettingsContent
      title={plugin?.manifest.name || "Linear"}
      description={plugin?.manifest.description || LINEAR_DESCRIPTION}
      backLink={{ href: "/settings/plugins", label: "Plugins" }}
    >
      <PluginHeaderSection state={pluginState} canEdit={canEdit} />
      <AccountsSection state={accountsState} />
      <ToolsSection
        pluginState={pluginState}
        state={toolsState}
        permissionConnection={
          accountsState.status === "ready" ? accountsState.permissionConnection : null
        }
      />
      <SkillsSection state={pluginState} />
    </SettingsContent>
  );
}

function PluginHeaderSection({ state, canEdit }: { state: PluginLoadState; canEdit: boolean }) {
  const router = useRouter();
  const [installing, setInstalling] = useState(false);
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (state.status === "loading") return <SectionSkeleton label="Loading Linear plugin" rows={2} />;
  if (state.status === "error") {
    return <SectionError title="Plugin details unavailable" message={state.message} />;
  }

  const plugin = state.plugin;
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
              <Button
                variant="outline"
                size="sm"
                disabled={isPending}
                onClick={() => setConfirmingUninstall(true)}
              >
                <Unplug className="size-3.5" /> Uninstall
              </Button>
            ) : (
              <Button size="sm" onClick={() => setInstalling(true)}>
                <PlugZap className="size-3.5" /> Install
              </Button>
            )
          ) : null}
        </div>
      </div>

      {plugin ? (
        <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border border-border bg-surface-muted px-3 py-2.5 text-[11.5px] leading-4">
          <dt className="text-ink-faint">Source</dt>
          <dd className="break-all text-ink">{plugin.source.url}</dd>
          <dt className="text-ink-faint">Commit</dt>
          <dd className="break-all font-mono text-ink">{plugin.source.resolvedCommit}</dd>
          <dt className="text-ink-faint">Integrity</dt>
          <dd className="break-all font-mono text-ink">{plugin.integrity}</dd>
        </dl>
      ) : (
        <SectionEmpty icon={PackageCheck}>
          Install the package to add Linear tools and skills. Your Linear accounts are connected
          separately and remain in place if you uninstall it.
        </SectionEmpty>
      )}

      {!canEdit ? (
        <p className="text-[12px] leading-4 text-ink-subtle">
          Only workspace admins can install or uninstall plugins.
        </p>
      ) : null}
      {error ? <SectionError title="Plugin update failed" message={error} /> : null}

      {installing ? (
        <InstallPluginDialog
          initialUrl={LINEAR_PLUGIN_SOURCE}
          expectedName={LINEAR_PLUGIN_NAME}
          lockSource
          onClose={() => {
            setInstalling(false);
            router.refresh();
          }}
          onComplete={() => {
            setInstalling(false);
            router.refresh();
          }}
        />
      ) : null}

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
  return (
    <section aria-labelledby="linear-accounts-heading" className="flex flex-col gap-3">
      <SectionHeading
        id="linear-accounts-heading"
        icon={Users}
        title="Accounts"
        description="Connections are separate from the plugin and remain available for ingestion after uninstall."
      />
      {state.status === "loading" ? (
        <SectionSkeleton label="Loading Linear accounts" rows={2} compact />
      ) : state.status === "error" ? (
        <SectionError title="Accounts unavailable" message={state.message} />
      ) : state.accounts.length === 0 ? (
        <SectionEmpty icon={Users}>No Linear accounts are connected.</SectionEmpty>
      ) : (
        <div className="flex flex-col gap-2">
          {state.accounts.map(({ account, purpose }) => (
            <IntegrationAccountRow
              key={account.integrationId}
              account={account}
              purposeLabel={purpose}
              showCapabilityModes={false}
            />
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <a
          href={LINEAR_TOOLS_CONNECT_HREF}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          {state.status === "ready" && state.permissionConnection
            ? "Reconnect tool account"
            : "Connect tool account"}
        </a>
        <a
          href={LINEAR_INGEST_CONNECT_HREF}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Add ingestion account
        </a>
      </div>
    </section>
  );
}

function ToolsSection({
  pluginState,
  state,
  permissionConnection,
}: {
  pluginState: PluginLoadState;
  state: PluginToolsState;
  permissionConnection: IntegrationAccountView | null;
}) {
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
      ) : !pluginState.plugin ? (
        <SectionEmpty icon={Wrench}>Install Linear to make its tools available.</SectionEmpty>
      ) : state.status === "loading" ? (
        <SectionSkeleton label="Discovering Linear tools" rows={2} />
      ) : state.status === "error" ? (
        <SectionError title="Tools unavailable" message={state.message} />
      ) : (
        <>
          {state.groups.every((group) => group.tools.length === 0) ? (
            <SectionEmpty icon={Wrench}>
              No tools have been discovered yet. Capability permissions are ready and will apply
              when gateway discovery reports Linear tools.
            </SectionEmpty>
          ) : null}
          <div className="flex flex-col gap-2">
            {state.groups.map((group) => (
              <ToolGroupCard
                key={group.id}
                group={group}
                permissionConnection={permissionConnection}
              />
            ))}
          </div>
          {!permissionConnection ? (
            <p className="text-[12px] leading-4 text-ink-subtle">
              Connect a Linear tool account to change permission modes.
            </p>
          ) : null}
        </>
      )}
    </section>
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
          {group.curated ? (
            <ToolRows tools={group.tools} />
          ) : (
            <details className="group rounded-md border border-border/70">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[12px] font-medium text-ink-muted">
                Advanced · {group.tools.length} {group.tools.length === 1 ? "tool" : "tools"}
                <ChevronDown className="ml-auto size-3.5 transition-transform group-open:rotate-180" />
              </summary>
              <div className="border-t border-border/70 p-2">
                <ToolRows tools={group.tools} />
              </div>
            </details>
          )}
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
  const stored = connection?.capabilityModes[group.modeKey];
  const mode = pendingMode ?? (isCapabilityMode(stored) ? stored : group.defaultMode);

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

function SkillsSection({ state }: { state: PluginLoadState }) {
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
      ) : !state.plugin ? (
        <SectionEmpty icon={Sparkles}>Install Linear to add its skills.</SectionEmpty>
      ) : state.plugin.skills.length === 0 ? (
        <SectionEmpty icon={Sparkles}>This version of the plugin contains no skills.</SectionEmpty>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border bg-surface">
          {state.plugin.skills.map((skill: LinearPluginSkill) => (
            <li key={skill.bundleId} className="border-b border-border px-3 py-2.5 last:border-b-0">
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
    accounts: [
      ...(permissionConnection
        ? [{ purpose: "Tools" as const, account: permissionConnection }]
        : []),
      ...state.personalAccounts.linear.map((account) => ({
        purpose: "Ingestion" as const,
        account,
      })),
    ],
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

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : "Something went wrong.";
}
