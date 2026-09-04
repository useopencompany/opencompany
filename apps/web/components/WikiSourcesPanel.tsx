"use client";

import type {
  IntegrationAccountReadModel,
  WikiSourceDto,
  WikiSourceProvider,
} from "@opencompany/protocol";
import { Alert, AlertDescription, AlertTitle } from "@opencompany/ui/components/alert";
import { Badge } from "@opencompany/ui/components/badge";
import { buttonVariants } from "@opencompany/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@opencompany/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { Skeleton } from "@opencompany/ui/components/skeleton";
import { toast } from "@opencompany/ui/components/sonner";
import { Switch } from "@opencompany/ui/components/switch";
import { cn } from "@opencompany/ui/lib/utils";
import { useLiveQuery } from "@tanstack/react-db";
import { ArrowLeft, CircleAlert, Loader2, Settings2 } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useAppDataOptional } from "@/components/AppDataProvider";
import { GranolaIntegrationSetup } from "@/components/GranolaIntegrationSetup";
import { useHydrated } from "@/components/useHydrated";
import {
  WikiIngestActivityFeed,
  WikiIngestActivitySkeleton,
} from "@/components/WikiIngestActivityFeed";
import { WikiGmailSourceEditor } from "@/components/WikiSourceScopeEditors";
import { WikiLinearTeamPicker } from "@/components/WikiSourceScopePickers";
import {
  getHeadlessIntegrationAccounts,
  type HeadlessIntegrationAccountReadModel,
} from "@/lib/headless-integration-collections";
import type { IntegrationState } from "@/lib/integration-state";
import { listWikiSources, setWikiSourceEnabled, upsertWikiSource } from "@/lib/wiki-source-api";
import { WIKI_SOURCE_PROVIDERS, type WikiSourceProviderDef } from "@/lib/wiki-sources/registry";

export type WikiSourceEntry = {
  integrationId: string;
  provider: WikiSourceProvider;
  status: IntegrationAccountReadModel["status"];
  accountName: string | null;
  accountEmail: string | null;
  connectionLabel: string | null;
  ownerName: string | null;
  source: WikiSourceDto | null;
  canToggle: boolean;
};

export type WikiSourceScopeSlot = (entry: WikiSourceEntry) => ReactNode;

export function WikiSourcesPanel({
  workspaceId,
  mode = "page",
  integrationState,
}: {
  workspaceId: string;
  isAdmin: boolean;
  mode?: "page" | "onboarding";
  integrationState?: IntegrationState;
}) {
  const hydrated = useHydrated();
  const initialIntegrations = useAppDataOptional()?.integrations;
  if (!hydrated) {
    return (
      <WikiSourcesLayout mode={mode}>
        <WikiSourceCardSkeletons />
        {mode === "page" ? <WikiIngestActivitySkeleton /> : null}
      </WikiSourcesLayout>
    );
  }
  return (
    <WikiSourcesLivePanel
      workspaceId={workspaceId}
      mode={mode}
      initialIntegrations={integrationState ?? initialIntegrations}
    />
  );
}

function WikiSourcesLivePanel({
  workspaceId,
  initialIntegrations,
  mode,
}: {
  workspaceId: string;
  initialIntegrations: IntegrationState | undefined;
  mode: "page" | "onboarding";
}) {
  const [sources, setSources] = useState<WikiSourceDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();
  const autoEnableAttempted = useRef(new Set<string>());
  const [setupProvider, setSetupProvider] = useState<"granola" | null>(null);

  const integrationCollection = useMemo(
    () => getHeadlessIntegrationAccounts(workspaceId),
    [workspaceId],
  );
  const { data: integrationRows, isLoading: integrationsLoading } = useLiveQuery(
    (q) => q.from({ integration: integrationCollection }),
    [integrationCollection],
  );
  const initialIntegrationRows = useMemo(
    () => wikiSourceIntegrationRowsFromState(initialIntegrations),
    [initialIntegrations],
  );
  const displayedIntegrationRows = useMemo(() => {
    if (integrationsLoading && !integrationRows?.length) return initialIntegrationRows;
    return (integrationRows ?? []) as HeadlessIntegrationAccountReadModel[];
  }, [initialIntegrationRows, integrationRows, integrationsLoading]);
  const integrationsReady =
    !integrationsLoading || Boolean(integrationRows?.length) || Boolean(initialIntegrations);
  const eligibleIntegrations = useMemo(
    () =>
      displayedIntegrationRows.filter((integration) =>
        isEligibleWikiSourceIntegration(integration),
      ),
    [displayedIntegrationRows],
  );

  const loadSources = async () => {
    try {
      setSources(await listWikiSources());
    } catch (error) {
      setLoadError(errorMessage(error, "Wiki sources could not be loaded. Try again."));
    }
  };

  useEffect(() => {
    let active = true;
    void listWikiSources().then(
      (loadedSources) => {
        if (active) setSources(loadedSources);
      },
      (error: unknown) => {
        if (active) {
          setLoadError(errorMessage(error, "Wiki sources could not be loaded. Try again."));
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const entriesByProvider = useMemo(
    () => buildEntriesByProvider(sources ?? [], eligibleIntegrations),
    [eligibleIntegrations, sources],
  );

  // Meeting sources have no picker step. Once a fresh Granola
  // connection appears in the live integration shape, attach it to the Wiki
  // immediately. Existing disabled rows stay disabled so pausing is durable.
  useEffect(() => {
    if (!sources || !integrationsReady) return;
    const candidates = ["granola"].flatMap((provider) =>
      (entriesByProvider.get(provider as WikiSourceProvider) ?? []).filter(
        (entry) =>
          !entry.source &&
          entry.status === "connected" &&
          entry.canToggle &&
          !autoEnableAttempted.current.has(entry.integrationId),
      ),
    );
    for (const entry of candidates) {
      autoEnableAttempted.current.add(entry.integrationId);
      setPendingIds((current) => new Set(current).add(entry.integrationId));
      void upsertWikiSource({
        integrationId: entry.integrationId,
        provider: entry.provider,
        enabled: true,
      })
        .then((source) => setSources((current) => mergeSource(current, source)))
        .catch((error) => {
          setRowErrors((current) => ({
            ...current,
            [entry.integrationId]: errorMessage(
              error,
              `${providerName(entry.provider)} could not be enabled automatically.`,
            ),
          }));
        })
        .finally(() => {
          setPendingIds((current) => {
            const next = new Set(current);
            next.delete(entry.integrationId);
            return next;
          });
        });
    }
  }, [entriesByProvider, integrationsReady, sources]);

  const updateEnabled = (entry: WikiSourceEntry, enabled: boolean) => {
    setRowErrors((current) => omitKey(current, entry.integrationId));
    setPendingIds((current) => new Set(current).add(entry.integrationId));
    startTransition(async () => {
      try {
        const source = entry.source
          ? await setWikiSourceEnabled(entry.source.id, enabled)
          : await upsertWikiSource({
              integrationId: entry.integrationId,
              provider: entry.provider,
              enabled,
            });
        setSources((current) => mergeSource(current, source));
        toast.success(
          enabled
            ? `${providerName(entry.provider)} is feeding the Wiki.`
            : `${providerName(entry.provider)} is paused.`,
        );
      } catch (error) {
        const message = errorMessage(error, "The Wiki source could not be updated. Try again.");
        setRowErrors((current) => ({ ...current, [entry.integrationId]: message }));
        toast.error(message);
      } finally {
        setPendingIds((current) => {
          const next = new Set(current);
          next.delete(entry.integrationId);
          return next;
        });
      }
    });
  };

  const saveScopeConfig = async (
    entry: WikiSourceEntry,
    config: Record<string, unknown>,
  ): Promise<boolean> => {
    setRowErrors((current) => omitKey(current, entry.integrationId));
    setPendingIds((current) => new Set(current).add(entry.integrationId));
    try {
      const source = await upsertWikiSource({
        integrationId: entry.integrationId,
        provider: entry.provider,
        enabled: entry.source?.enabled ?? true,
        config,
      });
      setSources((current) => mergeSource(current, source));
      toast.success(`${providerName(entry.provider)} scope updated.`);
      return true;
    } catch (error) {
      const message = errorMessage(error, "The Wiki source scope could not be saved. Try again.");
      setRowErrors((current) => ({ ...current, [entry.integrationId]: message }));
      toast.error(message);
      return false;
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(entry.integrationId);
        return next;
      });
    }
  };

  const renderScopeSlot = (entry: WikiSourceEntry) => {
    if (entry.status !== "connected") return null;
    const canConfigure = entry.source?.canConfigure ?? entry.canToggle;
    if (entry.provider === "gmail") {
      if (!canConfigure) return null;
      return (
        <WikiGmailSourceEditor
          integrationId={entry.integrationId}
          source={entry.source}
          onSave={(config) => saveScopeConfig(entry, config)}
        />
      );
    }
    if (entry.provider === "linear") {
      return (
        <WikiLinearTeamPicker
          integrationId={entry.integrationId}
          source={entry.source}
          canConfigure={canConfigure}
          onSaved={(source) => setSources((current) => mergeSource(current, source))}
        />
      );
    }
    return null;
  };

  const loading = !loadError && (sources === null || !integrationsReady);
  const feedingCount = [...entriesByProvider.values()]
    .flat()
    .filter((entry) => entry.source?.enabled && entry.status === "connected").length;

  return (
    <WikiSourcesLayout mode={mode}>
      {loadError ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Sources didn&apos;t load</AlertTitle>
          <AlertDescription>
            <p>{loadError}</p>
            <button
              type="button"
              onClick={() => {
                setLoadError(null);
                setSources(null);
                void loadSources();
              }}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Try again
            </button>
          </AlertDescription>
        </Alert>
      ) : null}

      {!loading && feedingCount === 0 ? (
        <Alert variant="info">
          <Settings2 />
          <AlertTitle>No sources are feeding yet</AlertTitle>
          <AlertDescription>
            Connect an account below or turn on a connected source. Meeting sources start feeding
            automatically after connection.
          </AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <WikiSourceCardSkeletons />
      ) : (
        <section
          aria-label="Wiki source providers"
          className={cn("grid gap-4", mode === "page" && "md:grid-cols-2")}
        >
          {WIKI_SOURCE_PROVIDERS.map((provider) => (
            <WikiSourceCard
              key={provider.id}
              provider={provider}
              entries={entriesByProvider.get(provider.id) ?? []}
              pendingIds={pendingIds}
              rowErrors={rowErrors}
              onEnabledChange={updateEnabled}
              connectHref={wikiSourceConnectHref(provider.connectHref, mode)}
              {...(provider.id === "granola"
                ? { onConnect: () => setSetupProvider("granola") }
                : {})}
              {...(provider.scopeRequired ? { scopeSlot: renderScopeSlot } : {})}
            />
          ))}
        </section>
      )}
      {mode === "page" ? <WikiIngestActivityFeed /> : null}
      {setupProvider ? (
        <WikiSourceSetupDialog
          integrations={initialIntegrations}
          onClose={() => setSetupProvider(null)}
        />
      ) : null}
    </WikiSourcesLayout>
  );
}

function WikiSourcesLayout({
  children,
  mode,
}: {
  children: ReactNode;
  mode: "page" | "onboarding";
}) {
  return (
    <div className={cn(mode === "page" && "min-h-0 flex-1 overflow-y-auto")}>
      <main
        className={cn(
          "mx-auto flex w-full flex-col gap-6",
          mode === "page" ? "max-w-5xl px-5 py-8 sm:px-8 sm:py-10" : "max-w-[560px]",
        )}
      >
        <header className="flex flex-col gap-3">
          {mode === "page" ? (
            <Link
              href="/wiki"
              className="inline-flex w-fit items-center gap-1.5 text-[12px] font-medium text-ink-subtle transition-colors hover:text-ink"
            >
              <ArrowLeft size={13} strokeWidth={1.9} />
              Back to Wiki
            </Link>
          ) : null}
          <div>
            <h1
              className={cn(
                "font-semibold tracking-[-0.02em] text-ink",
                mode === "page" ? "text-[24px]" : "text-[26px] leading-tight",
              )}
            >
              {mode === "page" ? "Wiki sources" : "Connect your sources"}
            </h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-5 text-ink-subtle">
              Connect accounts, then choose the channels of knowledge that should continuously feed
              your workspace Wiki. You can safely skip this and connect later from Wiki Sources.
            </p>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}

function WikiSourceCard({
  provider,
  entries,
  pendingIds,
  rowErrors,
  onEnabledChange,
  connectHref,
  onConnect,
  scopeSlot,
}: {
  provider: WikiSourceProviderDef;
  entries: WikiSourceEntry[];
  pendingIds: ReadonlySet<string>;
  rowErrors: Record<string, string>;
  onEnabledChange: (entry: WikiSourceEntry, enabled: boolean) => void;
  connectHref: string;
  onConnect?: () => void;
  scopeSlot?: WikiSourceScopeSlot;
}) {
  const Icon = provider.Icon;
  const feeding = entries.some((entry) => entry.source?.enabled && entry.status === "connected");
  const needsReconnect = entries.some(
    (entry) =>
      entry.status === "needs_reauth" ||
      entry.status === "sync_failed" ||
      entry.status === "disconnected",
  );

  return (
    <Card className="gap-4 bg-surface py-5">
      <CardHeader className="gap-2 px-5">
        <div
          className={cn("flex size-10 items-center justify-center rounded-lg", provider.tileClass)}
        >
          {Icon ? (
            <Icon size={19} />
          ) : (
            <span className="text-[15px] font-semibold">{provider.monogram}</span>
          )}
        </div>
        <CardTitle className="mt-1 text-[15px] text-ink">{provider.name}</CardTitle>
        <CardDescription className="text-[12px] leading-5 text-ink-subtle">
          {provider.description}
        </CardDescription>
        <CardAction>
          {feeding ? (
            <Badge variant="success">Feeding</Badge>
          ) : needsReconnect ? (
            <Badge variant="warning">Needs reconnect</Badge>
          ) : entries.length > 0 ? (
            <Badge variant="secondary">Connected · off</Badge>
          ) : (
            <Badge variant="outline">Not connected</Badge>
          )}
        </CardAction>
      </CardHeader>

      {entries.length > 0 ? (
        <CardContent className="flex flex-col gap-2 px-5">
          {entries.map((entry) => {
            const enabled = entry.source?.enabled ?? false;
            const pending = pendingIds.has(entry.integrationId);
            const canEnable = entry.status === "connected";
            const disabled = pending || !entry.canToggle || (!enabled && !canEnable);
            return (
              <div
                key={entry.integrationId}
                className="flex flex-col gap-2 rounded-lg border border-border/70 bg-canvas/60 px-3 py-2.5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] font-medium text-ink">
                      {connectionLabel(entry)}
                    </p>
                    <p className="mt-0.5 text-[11.5px] leading-4 text-ink-subtle">
                      {connectionStateCopy(entry)}
                    </p>
                  </div>
                  {pending ? <Loader2 className="size-3.5 animate-spin text-ink-subtle" /> : null}
                  <Switch
                    checked={enabled}
                    onCheckedChange={(checked) => onEnabledChange(entry, checked)}
                    disabled={disabled}
                    aria-label={`${enabled ? "Pause" : "Enable"} ${provider.name} source ${connectionLabel(entry)}`}
                  />
                </div>
                {scopeSlot ? scopeSlot(entry) : null}
                {rowErrors[entry.integrationId] ? (
                  <p className="text-[11.5px] leading-4 text-danger">
                    {rowErrors[entry.integrationId]}
                  </p>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      ) : null}

      <CardFooter className="mt-auto px-5">
        {entries.length === 0 ? (
          onConnect ? (
            <button
              type="button"
              onClick={onConnect}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Set up {provider.name}
            </button>
          ) : (
            <Link href={connectHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
              {provider.connectionKind === "oauth" ? "Connect" : "Set up"} {provider.name}
            </Link>
          )
        ) : needsReconnect ? (
          onConnect ? (
            <button
              type="button"
              onClick={onConnect}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Reconnect
            </button>
          ) : (
            <Link href={connectHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Reconnect
            </Link>
          )
        ) : provider.id === "gmail" || provider.id === "linear" || provider.id === "granola" ? (
          onConnect ? (
            <button
              type="button"
              onClick={onConnect}
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              Update API key
            </button>
          ) : (
            <Link href={connectHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Add another account
            </Link>
          )
        ) : null}
      </CardFooter>
    </Card>
  );
}

function wikiSourceConnectHref(href: string, mode: "page" | "onboarding") {
  if (mode === "page") return href;
  const url = new URL(href, "https://opencompany.local");
  url.searchParams.set("returnTo", "/onboarding/connected");
  return `${url.pathname}${url.search}`;
}

function WikiSourceSetupDialog({
  integrations,
  onClose,
}: {
  integrations: IntegrationState | undefined;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] max-w-[560px] overflow-y-auto">
        <DialogHeader className="mb-3 text-left">
          <DialogTitle>Connect Granola</DialogTitle>
          <DialogDescription>
            Use a Granola API key for legacy background ingestion into this workspace Wiki.
          </DialogDescription>
        </DialogHeader>
        <GranolaIntegrationSetup
          initialState={integrations?.granola ?? EMPTY_GRANOLA_STATE}
          variant="modal"
          onSaved={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}

const EMPTY_GRANOLA_STATE: IntegrationState["granola"] = {
  provider: "granola",
  connected: false,
  status: "not_connected",
  integrationId: null,
  accountEmail: null,
  accountName: null,
  statusReason: null,
};

function WikiSourceCardSkeletons() {
  return (
    <section aria-label="Loading Wiki sources" className="grid gap-4 md:grid-cols-2">
      {WIKI_SOURCE_PROVIDERS.map((provider) => (
        <Card key={provider.id} className="gap-4 py-5">
          <CardHeader className="px-5">
            <Skeleton className="size-10" />
            <Skeleton className="mt-2 h-4 w-24" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </CardHeader>
          <CardContent className="px-5">
            <Skeleton className="h-12 w-full" />
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

function buildEntriesByProvider(
  sources: WikiSourceDto[],
  integrations: HeadlessIntegrationAccountReadModel[],
) {
  const result = new Map<WikiSourceProvider, WikiSourceEntry[]>();
  const integrationsById = new Map(
    integrations.map((integration) => [integration.id, integration] as const),
  );
  const attachedIntegrationIds = new Set<string>();
  for (const source of sources) {
    const integration = integrationsById.get(source.integrationId);
    attachedIntegrationIds.add(source.integrationId);
    appendEntry(result, {
      integrationId: source.integrationId,
      provider: source.provider,
      status: integration?.status ?? source.integrationStatus,
      accountName: integration ? integration.accountName : source.accountName,
      accountEmail: integration ? integration.accountEmail : source.accountEmail,
      connectionLabel: integration ? integration.connectionLabel : source.connectionLabel,
      ownerName: source.ownerName,
      source,
      canToggle: source.canToggle,
    });
  }
  for (const integration of integrations) {
    if (attachedIntegrationIds.has(integration.id)) continue;
    const provider = integration.provider as WikiSourceProvider;
    appendEntry(result, {
      integrationId: integration.id,
      provider,
      status: integration.status,
      accountName: integration.accountName,
      accountEmail: integration.accountEmail,
      connectionLabel: integration.connectionLabel,
      ownerName: "You",
      source: null,
      canToggle: true,
    });
  }
  for (const entries of result.values()) {
    entries.sort((left, right) => connectionLabel(left).localeCompare(connectionLabel(right)));
  }
  return result;
}

function appendEntry(entries: Map<WikiSourceProvider, WikiSourceEntry[]>, entry: WikiSourceEntry) {
  const providerEntries = entries.get(entry.provider) ?? [];
  providerEntries.push(entry);
  entries.set(entry.provider, providerEntries);
}

function isEligibleWikiSourceIntegration(integration: HeadlessIntegrationAccountReadModel) {
  if (integration.status === "disconnected") return false;
  if (!WIKI_SOURCE_PROVIDERS.some((provider) => provider.id === integration.provider)) return false;
  if (integration.provider === "linear" && integration.externalId === "linear_mcp") return false;
  if (integration.provider === "granola" && integration.externalId === "granola_mcp") return false;
  return integration.workspaceId === null;
}

function wikiSourceIntegrationRowsFromState(
  integrations: IntegrationState | undefined,
): HeadlessIntegrationAccountReadModel[] {
  if (!integrations) return [];

  const rows: HeadlessIntegrationAccountReadModel[] = [];
  for (const provider of ["gmail", "linear", "granola"] as const) {
    for (const account of integrations.personalAccounts[provider]) {
      rows.push({
        id: account.integrationId,
        provider,
        workspaceId: null,
        externalId: "server-snapshot",
        connectionLabel: account.connectionLabel,
        accountName: account.accountName,
        accountEmail: account.accountEmail,
        accountType: null,
        status: account.status,
        statusReason: account.statusReason,
        scopes: account.scopes,
        capabilityModes: account.capabilityModes,
      });
    }
  }

  return rows;
}

function connectionLabel(entry: WikiSourceEntry) {
  if (entry.provider === "linear") {
    return (
      entry.connectionLabel ??
      entry.accountName ??
      entry.accountEmail ??
      entry.ownerName ??
      "Linear connection"
    );
  }
  return (
    entry.accountEmail ??
    entry.accountName ??
    entry.connectionLabel ??
    entry.ownerName ??
    `${providerName(entry.provider)} connection`
  );
}

function connectionStateCopy(entry: WikiSourceEntry) {
  if (entry.status === "disconnected") {
    return "This connection was removed. Reconnect it before feeding can resume.";
  }
  if (entry.status === "needs_reauth") return "Reconnect this account before feeding can resume.";
  if (entry.status === "sync_failed") return "The connection needs attention in Settings.";
  if (entry.source?.enabled) return "Enabled for this workspace Wiki.";
  if (entry.source) return "Connected, but currently paused.";
  return "Connected and ready to feed the Wiki.";
}

function mergeSource(current: WikiSourceDto[] | null, source: WikiSourceDto) {
  if (!current) return [source];
  const exists = current.some((entry) => entry.id === source.id);
  return exists
    ? current.map((entry) => (entry.id === source.id ? source : entry))
    : [...current, source];
}

function omitKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

function providerName(provider: WikiSourceProvider) {
  return WIKI_SOURCE_PROVIDERS.find((entry) => entry.id === provider)?.name ?? provider;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
