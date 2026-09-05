"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { cn } from "@opencompany/ui/lib/utils";
import { useLiveQuery } from "@tanstack/react-db";
import { ExternalLink, Globe2, Loader2, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { CapabilityModeToggle } from "@/components/CapabilityModeToggle";
import { useHydrated } from "@/components/useHydrated";
import {
  type CapabilityId,
  type CapabilityMode,
  effectiveCapabilityMode,
  type ProviderCapability,
  providerCapabilities,
} from "@/lib/actions/capabilities";
import {
  completeHeadlessBrowserProfileLogin,
  createHeadlessBrowserProfile,
  createHeadlessBrowserProfileLoginSession,
  deleteHeadlessBrowserProfile,
  listHeadlessBrowserProfiles,
} from "@/lib/headless-browser-profile-api";
import {
  getHeadlessIntegrationAccounts,
  type HeadlessIntegrationAccountReadModel,
} from "@/lib/headless-integration-collections";
import {
  disconnectIntegrationAccountAction,
  getIntegrationAccountUsageAction,
  setIntegrationCapabilityModeAction,
} from "@/lib/integration-account-actions";
import {
  type IntegrationAccountView,
  type IntegrationState,
  integrationStateFromRows,
  type PersonalAccountProvider,
} from "@/lib/integration-state";
import { gmailMcpScopesSatisfied } from "@/lib/integrations/gmail-scopes";
import { hasGoogleDriveWriteScope } from "@/lib/integrations/google-drive-scopes";
import {
  integrationConnectionError,
  integrationConnectionSuccess,
} from "@/lib/onboarding-integrations";

export function SettingsIntegrationsPanel({
  initialIntegrations,
  browserProfilesEnabled = false,
  scopeKey = "active",
}: {
  initialIntegrations: IntegrationState;
  isWorkspaceAdmin: boolean;
  browserProfilesEnabled?: boolean;
  scopeKey?: string;
}) {
  const hydrated = useHydrated();
  return (
    <>
      <IntegrationSetupFeedback />
      {!hydrated ? (
        <IntegrationCards
          integrations={initialIntegrations}
          browserProfilesEnabled={browserProfilesEnabled}
        />
      ) : (
        <LiveSettingsIntegrations
          initialIntegrations={initialIntegrations}
          browserProfilesEnabled={browserProfilesEnabled}
          scopeKey={scopeKey}
        />
      )}
    </>
  );
}

export function IntegrationSetupFeedback() {
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;

    const url = new URL(window.location.href);
    const status = url.searchParams.get("setup");
    if (status !== "connected" && status !== "error") return;

    handled.current = true;
    const provider = url.searchParams.get("integration");
    if (status === "error") {
      toast.error(integrationConnectionError(provider, url.searchParams.get("reason")));
    } else {
      toast.success(integrationConnectionSuccess(provider));
    }

    url.searchParams.delete("integration");
    url.searchParams.delete("setup");
    url.searchParams.delete("reason");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);

  return null;
}

function LiveSettingsIntegrations({
  initialIntegrations,
  browserProfilesEnabled,
  scopeKey,
}: {
  initialIntegrations: IntegrationState;
  browserProfilesEnabled: boolean;
  scopeKey: string;
}) {
  const integrationAccountsCollection = useMemo(
    () => getHeadlessIntegrationAccounts(scopeKey),
    [scopeKey],
  );
  const { data: rows, isLoading } = useLiveQuery(
    (q) => q.from({ integration: integrationAccountsCollection }),
    [integrationAccountsCollection],
  );
  const integrations = useMemo(() => {
    if (isLoading && !rows?.length) return initialIntegrations;
    const liveIntegrations = integrationStateFromRows(
      (rows ?? []) as HeadlessIntegrationAccountReadModel[],
    );
    return {
      ...liveIntegrations,
      codex: initialIntegrations.codex,
      claude_code: initialIntegrations.claude_code,
    };
  }, [initialIntegrations, isLoading, rows]);

  return (
    <IntegrationCards integrations={integrations} browserProfilesEnabled={browserProfilesEnabled} />
  );
}

type IntegrationScope = "workspace" | "personal";
type SettingsPersonalAccountProvider = Exclude<
  PersonalAccountProvider,
  "attio" | "fathom" | "granola" | "jamie" | "latitude" | "slack"
>;

// Group-card providers surfaced under each scope. These are all user-owned in the
// data model (each member connects their own account), but the CRM / meeting /
// issue-tracking tools read as shared workspace tooling, so we present them under
// the Workspace scope. Official Gmail, Calendar, Drive, HubSpot, Attio, and Granola tool accounts
// live under Plugins; their separate ingestion connections are managed from Wiki sources.
const WORKSPACE_ACCOUNT_PROVIDERS =
  [] as const satisfies readonly SettingsPersonalAccountProvider[];

function countConnectedAccounts(
  integrations: IntegrationState,
  providers: readonly SettingsPersonalAccountProvider[],
) {
  let count = 0;
  for (const provider of providers) {
    count += integrations.personalAccounts[provider].filter((account) => account.connected).length;
  }
  return count;
}

function countWorkspaceConnected(integrations: IntegrationState) {
  return countConnectedAccounts(integrations, WORKSPACE_ACCOUNT_PROVIDERS);
}

function countPersonalConnected() {
  return 0;
}

function IntegrationCards({
  integrations,
  browserProfilesEnabled,
}: {
  integrations: IntegrationState;
  browserProfilesEnabled: boolean;
}) {
  const [scope, setScope] = useState<IntegrationScope>("workspace");

  return (
    <div className="flex flex-col gap-6">
      <IntegrationScopeSwitch
        scope={scope}
        onScopeChange={setScope}
        workspaceCount={countWorkspaceConnected(integrations)}
        personalCount={countPersonalConnected()}
      />
      {scope === "workspace" ? (
        <section className="flex flex-col gap-3">
          <p className="text-[12px] leading-5 text-ink-subtle">
            Workspace integrations are managed from Plugins.
          </p>
          <Link
            href="/settings/plugins"
            className="w-fit text-[12px] font-medium text-ink underline decoration-border underline-offset-2 hover:text-ink-muted"
          >
            Open Plugins
          </Link>
        </section>
      ) : (
        <section className="flex flex-col gap-3">
          <p className="text-[12px] leading-5 text-ink-subtle">
            Connections that act as you. Only you can manage them or wire them into brains.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {browserProfilesEnabled ? <BrowserProfilesCard /> : null}
          </div>
        </section>
      )}
    </div>
  );
}

type BrowserProfileView = {
  id: string;
  name: string;
  siteHost: string;
  status: "pending_login" | "connected" | "needs_reauth" | "disconnected";
  active: boolean;
};

type LoginSessionView = {
  profileId: string;
  sessionId: string;
  liveViewUrl: string;
};

function BrowserProfilesCard() {
  const [profiles, setProfiles] = useState<BrowserProfileView[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [loginSession, setLoginSession] = useState<LoginSessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const refresh = async () => {
    const loaded = await listHeadlessBrowserProfiles();
    setProfiles(
      loaded.map((profile) => ({
        id: profile.id,
        name: profile.name,
        siteHost: profile.siteHost,
        status: profile.status,
        active: profile.active,
      })),
    );
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh().catch((err) => setError(err instanceof Error ? err.message : "Load failed."));
  }, []);

  const createAndLogin = () => {
    setError(null);
    startTransition(async () => {
      try {
        const created = await createHeadlessBrowserProfile({ name, url });
        setName("");
        setUrl("");
        await startLogin(created.id);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not connect browser profile.");
      }
    });
  };

  const startLogin = async (profileId: string) => {
    const session = await createHeadlessBrowserProfileLoginSession(profileId);
    setLoginSession({
      profileId,
      sessionId: session.sessionId,
      liveViewUrl: session.liveViewUrl,
    });
  };

  const completeLogin = () => {
    if (!loginSession) return;
    setError(null);
    startTransition(async () => {
      try {
        await completeHeadlessBrowserProfileLogin(loginSession.profileId, loginSession.sessionId);
        setLoginSession(null);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not complete login.");
      }
    });
  };

  const deleteProfile = (profileId: string) => {
    setError(null);
    startTransition(async () => {
      try {
        await deleteHeadlessBrowserProfile(profileId);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not delete browser profile.");
      }
    });
  };

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5 shadow-sm sm:col-span-2">
      <div className="flex items-start gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-[#0F766E] text-white">
          <Globe2 size={24} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold leading-tight text-ink">Browser profiles</div>
          <p className="mt-1 text-[13px] leading-5 text-ink-subtle">
            Saved login sessions for authenticated browser tasks.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Profile name"
          className="h-9 rounded-lg border border-border bg-canvas px-3 text-[13px] text-ink outline-none focus:border-ink/30"
        />
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com"
          className="h-9 rounded-lg border border-border bg-canvas px-3 text-[13px] text-ink outline-none focus:border-ink/30"
        />
        <button
          type="button"
          onClick={createAndLogin}
          disabled={isPending}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-ink px-3 text-[13px] font-medium text-canvas disabled:opacity-60"
        >
          {isPending ? <Loader2 size={14} className="animate-spin" /> : null}
          Connect
        </button>
      </div>
      {profiles.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {profiles.map((profile) => (
            <div
              key={profile.id}
              className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium leading-4 text-ink">
                  {profile.name}
                </div>
                <div className="truncate text-[12px] leading-4 text-ink-subtle">
                  {profile.siteHost}
                </div>
              </div>
              <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle">
                {profile.active ? "Active" : profile.status.replace("_", " ")}
              </span>
              {profile.status === "connected" ? null : (
                <button
                  type="button"
                  onClick={() =>
                    startTransition(() =>
                      startLogin(profile.id).catch((err) =>
                        setError(err instanceof Error ? err.message : "Could not start login."),
                      ),
                    )
                  }
                  disabled={isPending}
                  className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle hover:bg-surface-hover hover:text-ink disabled:opacity-60"
                >
                  Reconnect
                </button>
              )}
              <button
                type="button"
                onClick={() => deleteProfile(profile.id)}
                disabled={isPending}
                aria-label={`Delete ${profile.name}`}
                className="inline-flex size-7 items-center justify-center rounded-full text-ink-subtle hover:bg-surface-hover hover:text-ink disabled:opacity-60"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {loginSession ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-canvas p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] font-medium text-ink">Login handoff</span>
            <a
              href={loginSession.liveViewUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-subtle hover:text-ink"
            >
              Open
              <ExternalLink size={13} />
            </a>
          </div>
          <iframe
            src={loginSession.liveViewUrl}
            className="h-[420px] w-full rounded-lg border border-border bg-surface"
            title="Browser profile login"
          />
          <div>
            <button
              type="button"
              onClick={completeLogin}
              disabled={isPending}
              className="inline-flex h-9 items-center justify-center rounded-lg bg-ink px-3 text-[13px] font-medium text-canvas disabled:opacity-60"
            >
              I&apos;m logged in
            </button>
          </div>
        </div>
      ) : null}
      {error ? <div className="text-[12px] leading-4 text-warning">{error}</div> : null}
    </div>
  );
}

// Segmented control at the top of the page to flip between the workspace-owned
// connections and the personal ones, each with a live count of what's connected.
function IntegrationScopeSwitch({
  scope,
  onScopeChange,
  workspaceCount,
  personalCount,
}: {
  scope: IntegrationScope;
  onScopeChange: (scope: IntegrationScope) => void;
  workspaceCount: number;
  personalCount: number;
}) {
  const tabs: { key: IntegrationScope; label: string; count: number }[] = [
    { key: "workspace", label: "Workspace", count: workspaceCount },
    { key: "personal", label: "Personal", count: personalCount },
  ];

  return (
    <div className="inline-flex w-fit items-center gap-2">
      {tabs.map((tab) => {
        const active = scope === tab.key;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onScopeChange(tab.key)}
            aria-pressed={active}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20",
              active
                ? "bg-ink text-canvas"
                : "border border-border bg-surface text-ink hover:bg-surface-hover",
            )}
          >
            {tab.label}
            {tab.count > 0 ? (
              <span
                className={cn(
                  "inline-flex min-w-[18px] items-center justify-center rounded-full px-1 text-[11px] font-semibold leading-4",
                  active ? "bg-canvas/20 text-canvas" : "bg-surface-muted text-ink-subtle",
                )}
              >
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function IntegrationAccountRow({
  account,
  purposeLabel,
  reconnectHref,
  reconnectUnavailableReason,
  showCapabilityModes = true,
  capabilityIds,
  capabilityOverrides,
}: {
  account: IntegrationAccountView<PersonalAccountProvider | "posthog">;
  purposeLabel?: string;
  reconnectHref?: string;
  reconnectUnavailableReason?: string;
  showCapabilityModes?: boolean;
  capabilityIds?: readonly CapabilityId[];
  capabilityOverrides?: Partial<
    Record<CapabilityId, Partial<Pick<ProviderCapability, "label" | "description">>>
  >;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<{
    affectedBrainSourceCount: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const identity =
    account.provider === "slack" || account.provider === "x_account"
      ? [account.connectionLabel, account.accountName].filter(Boolean).join(" · ") ||
        account.accountEmail ||
        account.integrationId
      : account.provider === "linear" ||
          account.provider === "hubspot" ||
          account.provider === "attio"
        ? account.connectionLabel ||
          account.accountName ||
          account.accountEmail ||
          account.integrationId
        : account.accountEmail || account.accountName || account.integrationId;
  const needsGoogleDriveWriteScope =
    showCapabilityModes &&
    account.provider === "google_drive" &&
    account.connected &&
    !hasGoogleDriveWriteScope(account.scopes);
  const needsReconnect = account.status === "needs_reauth" || account.status === "sync_failed";
  const accountConnectHref =
    reconnectHref ??
    (account.provider === "posthog"
      ? "/api/integrations/posthog/start?returnTo=/settings/plugins/posthog"
      : account.provider === "jamie"
        ? "/api/integrations/jamie-mcp/start?returnTo=/settings/plugins/jamie"
        : account.provider === "granola"
          ? "/api/integrations/granola-mcp/start?returnTo=/settings/plugins/granola"
          : integrationConnectHref(account.provider));
  const needsGmailMcpScope =
    account.provider === "gmail" && account.connected && !gmailMcpScopesSatisfied(account.scopes);

  const beginDisconnect = () => {
    setError(null);
    startTransition(async () => {
      const usage = await getIntegrationAccountUsageAction(account.integrationId);
      if (!usage.ok) {
        setError(usage.error);
        return;
      }
      if (usage.affectedBrainSourceCount > 0) {
        setConfirming({
          affectedBrainSourceCount: usage.affectedBrainSourceCount,
        });
        return;
      }
      const result = await disconnectIntegrationAccountAction(account.integrationId);
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  };

  const confirmDisconnect = () => {
    setError(null);
    startTransition(async () => {
      const result = await disconnectIntegrationAccountAction(account.integrationId);
      if (!result.ok) setError(result.error);
      else {
        setConfirming(null);
        router.refresh();
      }
    });
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/70 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-ink-subtle">
          {identity}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {purposeLabel ? (
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle">
              {purposeLabel}
            </span>
          ) : null}
          {account.connected ? (
            <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle">
              Connected
            </span>
          ) : reconnectUnavailableReason ? (
            <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle">
              Unavailable
            </span>
          ) : needsReconnect ? (
            <span className="rounded-full bg-warning-bg px-2 py-0.5 text-[11px] font-medium leading-4 text-warning">
              Needs reconnect
            </span>
          ) : (
            <a
              href={accountConnectHref}
              className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
            >
              Reconnect
            </a>
          )}
          {needsGoogleDriveWriteScope ? (
            <a
              href={integrationConnectHref("google_drive")}
              className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
            >
              Enable Docs & Sheets editing
            </a>
          ) : null}
          {needsGmailMcpScope ? (
            <a
              href={accountConnectHref}
              className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
            >
              Enable full Gmail tools
            </a>
          ) : null}
          <button
            type="button"
            onClick={beginDisconnect}
            disabled={isPending}
            className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:opacity-60"
          >
            Disconnect
          </button>
        </div>
      </div>
      {needsReconnect ? (
        <div className="flex flex-col gap-1">
          {reconnectUnavailableReason || account.statusReason ? (
            <p className="text-[12px] leading-4 text-warning">
              {reconnectUnavailableReason || account.statusReason}
            </p>
          ) : null}
          {reconnectUnavailableReason ? null : (
            <a
              href={accountConnectHref}
              className="w-fit rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
            >
              Reconnect
            </a>
          )}
        </div>
      ) : null}
      {account.connected && showCapabilityModes ? (
        <CapabilityModeRows
          integrationId={account.integrationId}
          provider={account.provider}
          capabilityModes={account.capabilityModes}
          {...(capabilityIds ? { capabilityIds } : {})}
          {...(capabilityOverrides ? { capabilityOverrides } : {})}
        />
      ) : null}
      {confirming ? (
        <div className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-[12px] leading-5 text-ink-muted">
          <span>
            Disconnect {identity}? {confirming.affectedBrainSourceCount} brain source
            {confirming.affectedBrainSourceCount === 1 ? "" : "s"} fed by this account will stop
            ingesting.
          </span>
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              type="button"
              onClick={confirmDisconnect}
              disabled={isPending}
              className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-warning transition-colors duration-150 hover:bg-surface-hover disabled:opacity-60"
            >
              Disconnect account
            </button>
            <button
              type="button"
              onClick={() => setConfirming(null)}
              disabled={isPending}
              className="rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {error ? <div className="text-[12px] leading-4 text-warning">{error}</div> : null}
    </div>
  );
}

// What the chat is allowed to do with this connection: one row per registered
// capability with an On / Ask / Off pill.
function CapabilityModeRows({
  integrationId,
  provider,
  capabilityModes,
  capabilityIds,
  capabilityOverrides,
}: {
  integrationId: string;
  provider: PersonalAccountProvider | "posthog";
  capabilityModes: Record<string, unknown>;
  capabilityIds?: readonly CapabilityId[];
  capabilityOverrides?: Partial<
    Record<CapabilityId, Partial<Pick<ProviderCapability, "label" | "description">>>
  >;
}) {
  const capabilities = providerCapabilities(provider)
    .filter((capability) => !capabilityIds || capabilityIds.includes(capability.id))
    .map((capability) => ({ ...capability, ...capabilityOverrides?.[capability.id] }));
  if (capabilities.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 border-t border-border/60 pt-1.5">
      {capabilities.map((capability) => (
        <CapabilityModeRow
          key={capability.id}
          integrationId={integrationId}
          capability={capability}
          mode={effectiveCapabilityMode(provider, capability.id, capabilityModes)}
        />
      ))}
    </div>
  );
}

function CapabilityModeRow({
  integrationId,
  capability,
  mode,
}: {
  integrationId: string;
  capability: ProviderCapability;
  mode: CapabilityMode;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Optimistic selection so the pill flips immediately; the Electric row (or
  // router refresh) confirms it.
  const [pendingMode, setPendingMode] = useState<CapabilityMode | null>(null);
  const currentMode = pendingMode ?? mode;

  const select = (nextMode: CapabilityMode) => {
    if (nextMode === currentMode || isPending) return;
    setPendingMode(nextMode);
    startTransition(async () => {
      const result = await setIntegrationCapabilityModeAction(
        integrationId,
        capability.id,
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
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-[12px] leading-4 text-ink-muted"
          title={capability.description}
        >
          {capability.label}
        </div>
      </div>
      <CapabilityModeToggle
        label={capability.label}
        mode={currentMode}
        disabled={isPending}
        onChange={select}
      />
    </div>
  );
}

function integrationConnectHref(provider: PersonalAccountProvider) {
  if (provider === "gmail") return "/api/integrations/gmail/start?returnTo=/settings/integrations";
  if (provider === "google_calendar") {
    return "/api/integrations/google-calendar/start?returnTo=/settings/integrations";
  }
  if (provider === "google_drive") {
    return "/api/integrations/google-drive/start?returnTo=/settings/integrations";
  }
  if (provider === "github_user")
    return "/api/integrations/github-user/start?returnTo=/settings/plugins/github";
  if (provider === "granola")
    return "/api/integrations/granola-mcp/start?returnTo=/settings/plugins/granola";
  if (provider === "fathom")
    return "/api/integrations/fathom-mcp/start?returnTo=/settings/plugins/fathom";
  if (provider === "attio")
    return "/api/integrations/attio-mcp/start?returnTo=/settings/plugins/attio";
  if (provider === "slack") return "/settings/plugins/slack";
  if (provider === "hubspot")
    return "/api/integrations/hubspot/start?returnTo=/settings/integrations";
  if (provider === "latitude")
    return "/api/integrations/latitude/start?returnTo=/settings/plugins/latitude";
  if (provider === "neon") return "/api/integrations/neon/start?returnTo=/settings/integrations";
  if (provider === "betterstack") {
    return "/api/integrations/betterstack/start?returnTo=/settings/plugins/betterstack";
  }
  if (provider === "render") return "/settings/plugins/render#render-api-key";
  if (provider === "vercel") {
    return "/api/integrations/vercel/start?returnTo=/settings/plugins/vercel";
  }
  if (provider === "signoz") {
    return "/api/integrations/signoz/start?returnTo=/settings/plugins/signoz";
  }
  if (provider === "x_account")
    return "/api/integrations/x-account/start?returnTo=/settings/integrations";
  return "/api/integrations/linear/start?returnTo=/settings/integrations";
}
