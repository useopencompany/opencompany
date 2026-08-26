"use client";

import { toast } from "@opencompany/ui/components/sonner";
import {
  AnthropicIcon,
  AttioIcon,
  FathomIcon,
  GitHubIcon,
  GmailIcon,
  GoogleCalendarIcon,
  GoogleDriveIcon,
  GranolaIcon,
  HubSpotIcon,
  type LucideIcon as IconComponent,
  LinearIcon,
  NeonIcon,
  OpenAIIcon,
  PostHogIcon,
  SlackIcon,
  StripeIcon,
  XIcon,
} from "@opencompany/ui/icons";
import { cn } from "@opencompany/ui/lib/utils";
import { useLiveQuery } from "@tanstack/react-db";
import { ExternalLink, Globe2, Loader2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { CapabilityModeToggle } from "@/components/CapabilityModeToggle";
import { useHydrated } from "@/components/useHydrated";
import {
  type CapabilityMode,
  effectiveCapabilityMode,
  type ProviderCapability,
  providerCapabilities,
} from "@/lib/actions/capabilities";
import { disconnectClaudeCodeAuth, saveClaudeCodeToken } from "@/lib/claude-code-auth";
import {
  type CodexDeviceAuthFlow,
  disconnectCodexAuth,
  pollCodexDeviceAuth,
  startCodexDeviceAuth,
} from "@/lib/codex-auth";
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
  completeInfisicalAuth,
  disconnectInfisicalAuth,
  type InfisicalAuthFlow,
  startInfisicalAuth,
} from "@/lib/infisical-auth";
import {
  disconnectIntegrationAccountAction,
  getIntegrationAccountUsageAction,
  setIntegrationCapabilityModeAction,
} from "@/lib/integration-account-actions";
import {
  type ClaudeCodeProviderState,
  type CodexProviderState,
  type GitHubProviderState,
  type GoogleProviderState,
  type ImessageProviderState,
  type InfisicalProviderState,
  type IntegrationAccountView,
  type IntegrationState,
  integrationStateFromRows,
  type JamieProviderState,
  type LinearProviderState,
  type PersonalAccountProvider,
  type PostHogProviderState,
  type SlackProviderState,
  type StripeProviderState,
} from "@/lib/integration-state";
import { hasGmailDraftScope, hasGmailSendScope } from "@/lib/integrations/gmail-scopes";
import { hasGoogleDriveWriteScope } from "@/lib/integrations/google-drive-scopes";
import {
  integrationConnectionError,
  integrationConnectionSuccess,
} from "@/lib/onboarding-integrations";

// Presentation metadata for each integration card: the real brand logo (or a
// monogram fallback where no square vector mark exists), the colored logo tile,
// and a short connection-focused description. Keyed by provider so the card
// components derive everything from the provider string.
type IntegrationMetaKey =
  | PersonalAccountProvider
  | "github"
  | "jamie"
  | "posthog"
  | "stripe"
  | "infisical"
  | "codex"
  | "claude_code"
  | "imessage";

type IntegrationMeta = {
  label: string;
  description: string;
  // Brand logo component; when omitted the tile shows `monogram` instead.
  Icon?: IconComponent;
  monogram?: string;
  // Tailwind classes for the circular logo tile (background + icon/text color).
  tileClass: string;
};

const INTEGRATION_META: Record<IntegrationMetaKey, IntegrationMeta> = {
  github: {
    label: "GitHub",
    description: "Bring pull requests and issues from your repositories into opencompany.",
    Icon: GitHubIcon,
    tileClass: "bg-[#181717] text-white",
  },
  jamie: {
    label: "Jamie",
    description: "Meeting notes land in opencompany after every completed meeting.",
    monogram: "J",
    tileClass: "bg-[#5B5BD6] text-white",
  },
  gmail: {
    label: "Gmail",
    description: "Let opencompany read and act on your email.",
    Icon: GmailIcon,
    tileClass: "bg-[#EA4335] text-white",
  },
  google_calendar: {
    label: "Google Calendar",
    description: "Let opencompany view and update your schedule and events.",
    Icon: GoogleCalendarIcon,
    tileClass: "bg-[#1A73E8] text-white",
  },
  google_drive: {
    label: "Google Drive",
    description: "Sync files and folders you choose into opencompany.",
    Icon: GoogleDriveIcon,
    tileClass: "bg-[#1FA463] text-white",
  },
  linear: {
    label: "Linear",
    description: "Connect issues, projects, and comments from Linear.",
    Icon: LinearIcon,
    tileClass: "bg-[#5E6AD2] text-white",
  },
  posthog: {
    label: "PostHog",
    description: "Explore product analytics and create focused insights from opencompany.",
    Icon: PostHogIcon,
    tileClass: "bg-[#F54E00] text-white",
  },
  latitude: {
    label: "Latitude",
    description: "Observe, understand, and improve your AI agents from opencompany.",
    monogram: "L",
    tileClass: "bg-[#171717] text-white",
  },
  neon: {
    label: "Neon",
    description: "Inspect Neon projects and schemas, and run permission-gated read-only SQL.",
    Icon: NeonIcon,
    tileClass: "bg-[#00E599] text-[#0B0F14]",
  },
  slack: {
    label: "Slack",
    description: "Let opencompany search and read your Slack conversations.",
    Icon: SlackIcon,
    tileClass: "bg-[#4A154B] text-white",
  },
  hubspot: {
    label: "HubSpot",
    description: "Sync CRM activity on contacts, companies, and deals.",
    Icon: HubSpotIcon,
    tileClass: "bg-[#FF7A59] text-white",
  },
  attio: {
    label: "Attio",
    description: "Sync CRM records and notes from Attio.",
    Icon: AttioIcon,
    tileClass: "bg-[#111111] text-white",
  },
  stripe: {
    label: "Stripe",
    description:
      "Give opencompany read-only access to payment activity, subscriptions, and receivables.",
    Icon: StripeIcon,
    tileClass: "bg-[#635BFF] text-white",
  },
  infisical: {
    label: "Infisical",
    description: "Give workspace coding agents access to the real Infisical CLI.",
    monogram: "I",
    tileClass: "bg-[#6C47FF] text-white",
  },
  granola: {
    label: "Granola",
    description: "Meeting notes flow in once Granola finishes each summary.",
    Icon: GranolaIcon,
    tileClass: "bg-[#F0EBE1] text-[#1A1714]",
  },
  fathom: {
    label: "Fathom",
    description: "Meeting recordings flow in after Fathom finishes each summary.",
    Icon: FathomIcon,
    tileClass: "bg-[#1355FF] text-white",
  },
  codex: {
    label: "Codex",
    description: "Connect your Codex subscription so opencompany can run coding tasks.",
    Icon: OpenAIIcon,
    tileClass: "bg-black text-white",
  },
  claude_code: {
    label: "Claude Code",
    description: "Connect your Claude subscription so opencompany can run coding tasks.",
    Icon: AnthropicIcon,
    tileClass: "bg-[#CC785C] text-white",
  },
  imessage: {
    label: "iMessage",
    description: "Get important updates from opencompany as texts on your phone.",
    monogram: "iM",
    tileClass: "bg-[#34C759] text-white",
  },
  x_account: {
    label: "X",
    description: "Connect X accounts and publish account-specific posts from chat.",
    Icon: XIcon,
    tileClass: "bg-black text-white",
  },
};

export function SettingsIntegrationsPanel({
  initialIntegrations,
  isWorkspaceAdmin,
  imessageEnabled = false,
  browserProfilesEnabled = false,
  scopeKey = "active",
}: {
  initialIntegrations: IntegrationState;
  isWorkspaceAdmin: boolean;
  // The iMessage card only exists for users who turned the beta flag on in
  // Preferences; pairing state alone must not surface it.
  imessageEnabled?: boolean;
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
          isWorkspaceAdmin={isWorkspaceAdmin}
          imessageEnabled={imessageEnabled}
          browserProfilesEnabled={browserProfilesEnabled}
        />
      ) : (
        <LiveSettingsIntegrations
          initialIntegrations={initialIntegrations}
          isWorkspaceAdmin={isWorkspaceAdmin}
          imessageEnabled={imessageEnabled}
          browserProfilesEnabled={browserProfilesEnabled}
          scopeKey={scopeKey}
        />
      )}
    </>
  );
}

function IntegrationSetupFeedback() {
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
  isWorkspaceAdmin,
  imessageEnabled,
  browserProfilesEnabled,
  scopeKey,
}: {
  initialIntegrations: IntegrationState;
  isWorkspaceAdmin: boolean;
  imessageEnabled: boolean;
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
      jamie: {
        ...liveIntegrations.jamie,
        integrationId: initialIntegrations.jamie.integrationId,
        webhookUrl: initialIntegrations.jamie.webhookUrl,
        apiKeyConfigured: initialIntegrations.jamie.apiKeyConfigured,
      },
    };
  }, [initialIntegrations, isLoading, rows]);

  return (
    <IntegrationCards
      integrations={integrations}
      isWorkspaceAdmin={isWorkspaceAdmin}
      imessageEnabled={imessageEnabled}
      browserProfilesEnabled={browserProfilesEnabled}
    />
  );
}

type IntegrationScope = "workspace" | "personal";
type InfisicalHost = NonNullable<InfisicalProviderState["host"]>;

const INFISICAL_REGIONS = [
  { host: "https://app.infisical.com", label: "US" },
  { host: "https://eu.infisical.com", label: "EU" },
] as const satisfies ReadonlyArray<{ host: InfisicalHost; label: string }>;

// Group-card providers surfaced under each scope. These are all user-owned in the
// data model (each member connects their own account), but the CRM / meeting /
// issue-tracking tools read as shared workspace tooling, so we present them under
// the Workspace scope; Gmail / Calendar / Drive / Slack stay personal.
const WORKSPACE_ACCOUNT_PROVIDERS = [
  "hubspot",
  "attio",
  "granola",
  "fathom",
] as const satisfies readonly PersonalAccountProvider[];

const PERSONAL_ACCOUNT_PROVIDERS = [
  "gmail",
  "google_calendar",
  "google_drive",
  "slack",
  "latitude",
  "neon",
] as const satisfies readonly PersonalAccountProvider[];

function countConnectedAccounts(
  integrations: IntegrationState,
  providers: readonly PersonalAccountProvider[],
) {
  let count = 0;
  for (const provider of providers) {
    count += integrations.personalAccounts[provider].filter((account) => account.connected).length;
  }
  return count;
}

function countWorkspaceConnected(integrations: IntegrationState) {
  return (
    (integrationStatus(integrations.github) === "Connected" ? 1 : 0) +
    (integrationStatus(integrations.jamie) === "Connected" ? 1 : 0) +
    (integrationStatus(integrations.linear) === "Connected" ? 1 : 0) +
    (integrationStatus(integrations.posthog) === "Connected" ? 1 : 0) +
    (integrationStatus(integrations.stripe) === "Connected" ? 1 : 0) +
    (integrations.infisical.connected ? 1 : 0) +
    countConnectedAccounts(integrations, WORKSPACE_ACCOUNT_PROVIDERS)
  );
}

function countPersonalConnected(integrations: IntegrationState, includeImessage: boolean) {
  return (
    countConnectedAccounts(integrations, PERSONAL_ACCOUNT_PROVIDERS) +
    (integrations.codex.connected ? 1 : 0) +
    (integrations.claude_code.connected ? 1 : 0) +
    (includeImessage && integrations.imessage.connected ? 1 : 0)
  );
}

function IntegrationCards({
  integrations,
  isWorkspaceAdmin,
  imessageEnabled,
  browserProfilesEnabled,
}: {
  integrations: IntegrationState;
  isWorkspaceAdmin: boolean;
  imessageEnabled: boolean;
  browserProfilesEnabled: boolean;
}) {
  const [scope, setScope] = useState<IntegrationScope>("workspace");

  return (
    <div className="flex flex-col gap-6">
      <IntegrationScopeSwitch
        scope={scope}
        onScopeChange={setScope}
        workspaceCount={countWorkspaceConnected(integrations)}
        personalCount={countPersonalConnected(integrations, imessageEnabled)}
      />
      {scope === "workspace" ? (
        <section className="flex flex-col gap-3">
          <p className="text-[12px] leading-5 text-ink-subtle">
            {`Shared connections available across this workspace.${
              isWorkspaceAdmin ? "" : " Managed by workspace admins."
            }`}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <InfisicalIntegrationCard
              integration={integrations.infisical}
              canManage={isWorkspaceAdmin}
            />
            <IntegrationCardRow integration={integrations.github} canConnect={isWorkspaceAdmin} />
            <IntegrationCardRow integration={integrations.jamie} canConnect={isWorkspaceAdmin} />
            <IntegrationCardRow integration={integrations.linear} />
            <IntegrationCardRow integration={integrations.posthog} />
            <IntegrationCardRow integration={integrations.stripe} canConnect={isWorkspaceAdmin} />
            <IntegrationProviderGroupCard
              provider="hubspot"
              accounts={integrations.personalAccounts.hubspot}
            />
            <IntegrationProviderGroupCard
              provider="attio"
              accounts={integrations.personalAccounts.attio}
            />
            <IntegrationProviderGroupCard
              provider="granola"
              accounts={integrations.personalAccounts.granola}
            />
            <IntegrationProviderGroupCard
              provider="fathom"
              accounts={integrations.personalAccounts.fathom}
            />
          </div>
        </section>
      ) : (
        <section className="flex flex-col gap-3">
          <p className="text-[12px] leading-5 text-ink-subtle">
            Connections that act as you. Only you can manage them or wire them into brains.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <IntegrationProviderGroupCard
              provider="gmail"
              accounts={integrations.personalAccounts.gmail}
            />
            <IntegrationProviderGroupCard
              provider="google_calendar"
              accounts={integrations.personalAccounts.google_calendar}
            />
            <IntegrationProviderGroupCard
              provider="google_drive"
              accounts={integrations.personalAccounts.google_drive}
            />
            <IntegrationProviderGroupCard
              provider="slack"
              accounts={integrations.personalAccounts.slack}
            />
            <IntegrationProviderGroupCard
              provider="latitude"
              accounts={integrations.personalAccounts.latitude}
            />
            <IntegrationProviderGroupCard
              provider="neon"
              accounts={integrations.personalAccounts.neon}
            />
            <IntegrationProviderGroupCard
              provider="x_account"
              accounts={integrations.personalAccounts.x_account}
            />
            <CodexIntegrationCard integration={integrations.codex} />
            <ClaudeCodeIntegrationCard integration={integrations.claude_code} />
            {imessageEnabled ? (
              <IMessageIntegrationCard integration={integrations.imessage} />
            ) : null}
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

// The card shell that matches every integration: a colored brand-logo tile, the
// title + description, an optional body (connected accounts, code panels), and a
// footer action pinned to the bottom so the "Connect" pills line up across a row.
function IntegrationCard({
  meta,
  body,
  footer,
}: {
  meta: IntegrationMeta;
  body?: ReactNode;
  footer?: ReactNode;
}) {
  const Icon = meta.Icon;
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <div
        className={cn(
          "flex size-12 shrink-0 items-center justify-center rounded-full",
          meta.tileClass,
        )}
      >
        {Icon ? (
          <Icon size={24} />
        ) : (
          <span className="text-[18px] font-semibold leading-none">{meta.monogram}</span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[15px] font-semibold leading-tight text-ink">{meta.label}</span>
        <p className="text-[13px] leading-5 text-ink-subtle">{meta.description}</p>
      </div>
      {body}
      {footer ? <div className="mt-auto pt-1">{footer}</div> : null}
    </div>
  );
}

// The outline pill used for navigation actions (Connect / Reconnect / Set up).
function ConnectLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className="inline-flex items-center justify-center rounded-full border border-border px-4 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      {label}
    </a>
  );
}

function ConnectedStatus({ label = "Connected" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-subtle">
      <span className="size-1.5 rounded-full bg-[#22C55E]" aria-hidden="true" />
      {label}
    </span>
  );
}

function NeedsReconnectStatus() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-warning">
      <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
      Needs reconnect
    </span>
  );
}

function NotConnectedStatus() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-subtle">
      <span className="size-1.5 rounded-full bg-ink-subtle/40" aria-hidden="true" />
      Not connected
    </span>
  );
}

// Single workspace connection (GitHub, Jamie): one status per provider. Renders
// read-only for non-admin members via `canConnect`.
function IntegrationCardRow({
  integration,
  canConnect = true,
}: {
  integration:
    | GoogleProviderState
    | LinearProviderState
    | PostHogProviderState
    | GitHubProviderState
    | JamieProviderState
    | SlackProviderState
    | StripeProviderState;
  canConnect?: boolean;
}) {
  const meta = INTEGRATION_META[integration.provider];
  const status = integrationStatus(integration);
  const connectHref = integrationConnectHref(integration.provider);
  const connected = status === "Connected";
  const needsReconnect = integrationNeedsReconnect(integration);
  const statusReason = integrationStatusReason(integration);
  const accountLabel =
    integration.provider === "linear" || integration.provider === "posthog"
      ? integration.accountName
      : integration.provider === "github"
        ? integration.accountName
        : integration.provider === "jamie"
          ? integration.accountName
          : integration.provider === "stripe"
            ? [integration.accountName, integration.livemode === false ? "Test mode" : null]
                .filter(Boolean)
                .join(" · ") || null
            : integration.provider === "slack"
              ? [integration.teamName, integration.accountName].filter(Boolean).join(" · ") || null
              : (integration.accountEmail ?? integration.accountName);
  const capabilityBody =
    connected &&
    (integration.provider === "linear" || integration.provider === "posthog") &&
    integration.integrationId ? (
      <CapabilityModeRows
        integrationId={integration.integrationId}
        provider={integration.provider}
        capabilityModes={integration.capabilityModes}
      />
    ) : undefined;

  return (
    <IntegrationCard
      meta={meta}
      body={capabilityBody}
      footer={
        connected ? (
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-1.5">
              <ConnectedStatus />
              {accountLabel ? (
                <span className="truncate text-[12px] leading-4 text-ink-subtle">
                  · {accountLabel}
                </span>
              ) : null}
            </div>
            {integration.provider === "github" && canConnect ? (
              <ConnectLink href="/settings/repositories" label="Configure repositories" />
            ) : integration.provider === "stripe" && canConnect ? (
              <ConnectLink href={connectHref} label="Manage" />
            ) : null}
          </div>
        ) : needsReconnect && canConnect ? (
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-1.5">
                <NeedsReconnectStatus />
                {accountLabel ? (
                  <span className="truncate text-[12px] leading-4 text-ink-subtle">
                    · {accountLabel}
                  </span>
                ) : null}
              </div>
              <ConnectLink href={connectHref} label="Reconnect" />
            </div>
            {statusReason ? (
              <p className="text-[12px] leading-4 text-warning">{statusReason}</p>
            ) : null}
          </div>
        ) : canConnect ? (
          <ConnectLink href={connectHref} label={status} />
        ) : (
          <NotConnectedStatus />
        )
      }
    />
  );
}

// A personal provider with any number of connected accounts. Zero accounts
// renders the classic "Connect" card; with accounts, each connection gets its
// own row inside the card (identity + status + disconnect) plus an "Add account"
// affordance — a second OAuth pass creates a second integration row.
function IntegrationProviderGroupCard({
  provider,
  accounts,
}: {
  provider: PersonalAccountProvider;
  accounts: IntegrationAccountView[];
}) {
  const meta = INTEGRATION_META[provider];
  const connectHref = integrationConnectHref(provider);
  if (accounts.length === 0) {
    return (
      <IntegrationCard meta={meta} footer={<ConnectLink href={connectHref} label="Connect" />} />
    );
  }
  return (
    <IntegrationCard
      meta={meta}
      body={
        <div className="flex flex-col gap-1.5">
          {accounts.map((account) => (
            <IntegrationAccountRow key={account.integrationId} account={account} />
          ))}
        </div>
      }
      footer={
        <ConnectLink
          href={connectHref}
          label={
            provider === "google_calendar"
              ? "Reconnect or add"
              : provider === "neon"
                ? "Reconnect"
                : "Add account"
          }
        />
      }
    />
  );
}

export function IntegrationAccountRow({
  account,
  purposeLabel,
  showCapabilityModes = true,
}: {
  account: IntegrationAccountView;
  purposeLabel?: string;
  showCapabilityModes?: boolean;
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
    account.provider === "google_drive" &&
    account.connected &&
    !hasGoogleDriveWriteScope(account.scopes);
  const needsReconnect = account.status === "needs_reauth" || account.status === "sync_failed";
  const gmailScopeUpgradeLabel =
    account.provider === "gmail" && account.connected && !hasGmailDraftScope(account.scopes)
      ? hasGmailSendScope(account.scopes)
        ? "Enable drafts"
        : "Enable drafts & sending"
      : null;

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
          ) : needsReconnect ? (
            <span className="rounded-full bg-warning-bg px-2 py-0.5 text-[11px] font-medium leading-4 text-warning">
              Needs reconnect
            </span>
          ) : (
            <a
              href={integrationConnectHref(account.provider)}
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
          {gmailScopeUpgradeLabel ? (
            <a
              href={integrationConnectHref("gmail")}
              className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
            >
              {gmailScopeUpgradeLabel}
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
          {account.statusReason ? (
            <p className="text-[12px] leading-4 text-warning">{account.statusReason}</p>
          ) : null}
          <a
            href={integrationConnectHref(account.provider)}
            className="w-fit rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
          >
            Reconnect
          </a>
        </div>
      ) : null}
      {account.connected && showCapabilityModes ? (
        <CapabilityModeRows
          integrationId={account.integrationId}
          provider={account.provider}
          capabilityModes={account.capabilityModes}
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
}: {
  integrationId: string;
  provider: PersonalAccountProvider | "posthog";
  capabilityModes: Record<string, unknown>;
}) {
  const capabilities = providerCapabilities(provider);
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

function InfisicalIntegrationCard({
  integration,
  canManage,
}: {
  integration: InfisicalProviderState;
  canManage: boolean;
}) {
  const router = useRouter();
  const [flow, setFlow] = useState<InfisicalAuthFlow | null>(null);
  const [host, setHost] = useState<InfisicalHost>(
    integration.host === "https://eu.infisical.com"
      ? "https://eu.infisical.com"
      : "https://app.infisical.com",
  );
  const [browserToken, setBrowserToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const startAuth = () => {
    setError(null);
    setBrowserToken("");
    startTransition(async () => {
      const result = await startInfisicalAuth({ host });
      if (result.ok) setFlow(result.flow);
      else setError(result.error);
    });
  };

  const completeAuth = () => {
    if (!flow) return;
    setError(null);
    startTransition(async () => {
      const result = await completeInfisicalAuth({ flowId: flow.id, browserToken });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.flow.status === "completed") {
        setFlow(null);
        setBrowserToken("");
        router.refresh();
      } else {
        setFlow(result.flow);
        setError(result.flow.statusReason);
      }
    });
  };

  const disconnect = () => {
    if (
      !window.confirm(
        "Disconnect Infisical from this workspace? New coding turns will remove the saved login. Commands already running are not interrupted.",
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await disconnectInfisicalAuth();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setFlow(null);
      setBrowserToken("");
      router.refresh();
    });
  };

  const regionLabel = INFISICAL_REGIONS.find((region) => region.host === host)?.label ?? "US";
  const connectedRegionLabel =
    INFISICAL_REGIONS.find((region) => region.host === integration.host)?.label ?? regionLabel;
  const accountLabel = integration.connected
    ? integration.accountEmail
      ? `Connected as ${integration.accountEmail} · ${connectedRegionLabel}`
      : `Connected · ${connectedRegionLabel}`
    : integration.statusReason;

  return (
    <IntegrationCard
      meta={INTEGRATION_META.infisical}
      body={
        <div className="flex flex-col gap-2">
          <p className="text-[12px] leading-5 text-ink-muted">
            Coding agents get this account&apos;s Infisical permissions, including secret writes.
            Use a dedicated, least-privilege account.
          </p>
          {accountLabel ? (
            <p className="truncate text-[12px] leading-4 text-ink-subtle">{accountLabel}</p>
          ) : null}
          {!canManage ? (
            <p className="text-[12px] leading-4 text-ink-subtle">Managed by workspace admins.</p>
          ) : null}
          {canManage && flow?.status !== "link_ready" ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12px] leading-4 text-ink-subtle">Region</span>
              <div
                role="group"
                aria-label="Infisical region"
                className="inline-flex rounded-full bg-surface-muted p-0.5"
              >
                {INFISICAL_REGIONS.map((region) => {
                  const selected = region.host === host;
                  return (
                    <button
                      key={region.host}
                      type="button"
                      aria-pressed={selected}
                      disabled={isPending}
                      onClick={() => setHost(region.host)}
                      className={cn(
                        "rounded-full px-2.5 py-0.5 text-[11px] font-medium leading-4 transition-colors duration-150",
                        selected
                          ? "bg-surface text-ink shadow-sm"
                          : "text-ink-subtle hover:text-ink",
                      )}
                    >
                      {region.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          {flow?.status === "link_ready" && flow.loginUrl ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-muted px-3 py-2 text-[12px] leading-5 text-ink-muted">
              <span>
                Open Infisical {regionLabel}, finish signing in without changing regions, then copy
                the browser token immediately.
              </span>
              <a
                href={flow.loginUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-fit items-center gap-1.5 font-medium text-ink underline underline-offset-2"
              >
                Open Infisical sign-in
                <ExternalLink size={13} />
              </a>
              <input
                type="password"
                value={browserToken}
                onChange={(event) => setBrowserToken(event.target.value)}
                placeholder="Paste browser token"
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              />
            </div>
          ) : null}
          {flow?.statusReason || error ? (
            <div className="text-[12px] leading-4 text-warning">{error ?? flow?.statusReason}</div>
          ) : null}
        </div>
      }
      footer={
        canManage ? (
          <div className="flex items-center gap-2">
            {flow?.status === "link_ready" ? (
              <>
                <button
                  type="button"
                  onClick={completeAuth}
                  disabled={isPending || !browserToken.trim()}
                  aria-busy={isPending}
                  className="inline-flex items-center justify-center rounded-full border border-border px-4 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-60"
                >
                  {isPending ? "Connecting" : "Finish connection"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFlow(null);
                    setBrowserToken("");
                    setError(null);
                  }}
                  disabled={isPending}
                  className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[13px] font-medium text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:opacity-60"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={startAuth}
                  disabled={isPending}
                  aria-busy={isPending}
                  className="inline-flex items-center justify-center rounded-full border border-border px-4 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-60"
                >
                  {buttonLabel(integration.status, isPending)}
                </button>
                {integration.connected ? (
                  <button
                    type="button"
                    onClick={disconnect}
                    disabled={isPending}
                    className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[13px] font-medium text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:opacity-60"
                  >
                    Disconnect
                  </button>
                ) : null}
              </>
            )}
          </div>
        ) : null
      }
    />
  );
}

function CodexIntegrationCard({ integration }: { integration: CodexProviderState }) {
  const router = useRouter();
  const [flow, setFlow] = useState<CodexDeviceAuthFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [isPending, startTransition] = useTransition();
  const status = flow?.status ?? integration.status;

  useEffect(() => {
    if (
      !flow ||
      flow.status === "completed" ||
      flow.status === "failed" ||
      flow.status === "expired"
    ) {
      return;
    }

    let active = true;
    let pollInFlight = false;
    const timer = window.setInterval(() => {
      if (pollInFlight) return;
      pollInFlight = true;
      setIsPolling(true);
      void (async () => {
        try {
          const result = await pollCodexDeviceAuth(flow.id);
          if (!active) return;
          if (result.ok) {
            if (result.flow.status === "completed") {
              setFlow(null);
              setError(null);
              router.refresh();
            } else {
              setFlow(result.flow);
            }
          } else {
            setError(result.error);
          }
        } finally {
          pollInFlight = false;
          if (active) setIsPolling(false);
        }
      })();
    }, 2500);

    return () => {
      active = false;
      window.clearInterval(timer);
      setIsPolling(false);
    };
  }, [flow, router]);

  const startAuth = () => {
    setError(null);
    startTransition(async () => {
      const result = await startCodexDeviceAuth();
      if (result.ok) {
        if (result.flow.status === "completed") {
          setFlow(null);
          router.refresh();
        } else {
          setFlow(result.flow);
        }
      } else {
        setError(result.error);
      }
    });
  };

  const disconnect = () => {
    setError(null);
    setIsPolling(false);
    startTransition(async () => {
      await disconnectCodexAuth();
      setFlow(null);
      router.refresh();
    });
  };

  const accountLabel =
    integration.status === "connected"
      ? integration.lastValidatedAt
        ? `Validated ${formatDateTime(integration.lastValidatedAt)}`
        : "Subscription connected"
      : integration.statusReason;

  return (
    <IntegrationCard
      meta={INTEGRATION_META.codex}
      body={
        <div className="flex flex-col gap-2">
          {accountLabel ? (
            <p className="truncate text-[12px] leading-4 text-ink-subtle">{accountLabel}</p>
          ) : null}
          {flow?.status === "code_ready" && flow.verificationUri && flow.userCode ? (
            <div className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-[12px] leading-5 text-ink-muted">
              <a
                href={flow.verificationUri}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-ink underline underline-offset-2"
              >
                Open Codex sign-in
              </a>
              <span> and enter </span>
              <span className="font-mono font-semibold text-ink">{flow.userCode}</span>
            </div>
          ) : null}
          {flow?.statusReason || error ? (
            <div className="text-[12px] leading-4 text-warning">{error ?? flow?.statusReason}</div>
          ) : null}
        </div>
      }
      footer={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={startAuth}
            disabled={isPending}
            aria-busy={isPending || isPolling}
            className="inline-flex items-center justify-center rounded-full border border-border px-4 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-60"
          >
            {buttonLabel(status, isPending)}
          </button>
          {integration.connected ? (
            <button
              type="button"
              onClick={disconnect}
              disabled={isPending}
              className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[13px] font-medium text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:opacity-60"
            >
              Disconnect
            </button>
          ) : null}
        </div>
      }
    />
  );
}

function ClaudeCodeIntegrationCard({ integration }: { integration: ClaudeCodeProviderState }) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submitToken = () => {
    setError(null);
    startTransition(async () => {
      const result = await saveClaudeCodeToken(token);
      if (result.ok) {
        setToken("");
        setShowForm(false);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  const disconnect = () => {
    setError(null);
    startTransition(async () => {
      await disconnectClaudeCodeAuth();
      setShowForm(false);
      router.refresh();
    });
  };

  const accountLabel =
    integration.status === "connected"
      ? integration.lastValidatedAt
        ? `Connected ${formatDateTime(integration.lastValidatedAt)}`
        : "Token saved; validation pending"
      : integration.statusReason;

  return (
    <IntegrationCard
      meta={INTEGRATION_META.claude_code}
      body={
        <div className="flex flex-col gap-2">
          {accountLabel ? (
            <p className="truncate text-[12px] leading-4 text-ink-subtle">{accountLabel}</p>
          ) : null}
          {showForm ? (
            <div className="flex flex-col gap-2">
              <p className="text-[12px] leading-5 text-ink-muted">
                Run <span className="font-mono font-semibold text-ink">claude setup-token</span> on
                your machine, approve in the browser, and paste the token here. Tokens last about a
                year.
              </p>
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="sk-ant-oat…"
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              />
            </div>
          ) : null}
          {error ? <div className="text-[12px] leading-4 text-warning">{error}</div> : null}
        </div>
      }
      footer={
        <div className="flex items-center gap-2">
          {showForm ? (
            <>
              <button
                type="button"
                onClick={submitToken}
                disabled={isPending || !token.trim()}
                aria-busy={isPending}
                className="inline-flex items-center justify-center rounded-full border border-border px-4 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-60"
              >
                {isPending ? "Working" : "Save token"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setToken("");
                  setError(null);
                }}
                disabled={isPending}
                className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[13px] font-medium text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:opacity-60"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setShowForm(true)}
                disabled={isPending}
                className="inline-flex items-center justify-center rounded-full border border-border px-4 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-60"
              >
                {buttonLabel(integration.status, isPending)}
              </button>
              {integration.connected ? (
                <button
                  type="button"
                  onClick={disconnect}
                  disabled={isPending}
                  className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[13px] font-medium text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:opacity-60"
                >
                  Disconnect
                </button>
              ) : null}
            </>
          )}
        </div>
      }
    />
  );
}

function IMessageIntegrationCard({ integration }: { integration: ImessageProviderState }) {
  return (
    <IntegrationCard
      meta={INTEGRATION_META.imessage}
      footer={
        integration.connected ? (
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-1.5">
              <ConnectedStatus />
              {integration.phoneE164 ? (
                <span className="truncate text-[12px] leading-4 text-ink-subtle">
                  · {integration.phoneE164}
                </span>
              ) : null}
            </div>
            <ConnectLink href="/settings/imessage" label="Manage" />
          </div>
        ) : (
          <ConnectLink href="/settings/imessage" label="Set up" />
        )
      }
    />
  );
}

function integrationStatus(
  integration:
    | GoogleProviderState
    | LinearProviderState
    | PostHogProviderState
    | GitHubProviderState
    | JamieProviderState
    | SlackProviderState
    | StripeProviderState,
) {
  if (integration.status === "connected") return "Connected";
  if (integration.provider === "jamie" && integration.apiKeyConfigured) return "Connected";
  if (integration.provider === "jamie" && integration.status === "needs_reauth")
    return "Finish setup";
  if (integration.status === "needs_reauth" || integration.status === "sync_failed") {
    return "Reconnect";
  }
  return "Connect";
}

function integrationNeedsReconnect(
  integration:
    | GoogleProviderState
    | LinearProviderState
    | PostHogProviderState
    | GitHubProviderState
    | JamieProviderState
    | SlackProviderState
    | StripeProviderState,
) {
  return integration.status === "needs_reauth" || integration.status === "sync_failed";
}

function integrationStatusReason(
  integration:
    | GoogleProviderState
    | LinearProviderState
    | PostHogProviderState
    | GitHubProviderState
    | JamieProviderState
    | SlackProviderState
    | StripeProviderState,
) {
  return "statusReason" in integration ? integration.statusReason : null;
}

function integrationConnectHref(
  provider: Exclude<IntegrationMetaKey, "codex" | "claude_code" | "infisical">,
) {
  if (provider === "gmail") return "/api/integrations/gmail/start?returnTo=/settings/integrations";
  if (provider === "google_calendar") {
    return "/api/integrations/google-calendar/start?returnTo=/settings/integrations";
  }
  if (provider === "google_drive") {
    return "/api/integrations/google-drive/start?returnTo=/settings/integrations";
  }
  if (provider === "github")
    return "/api/integrations/github/start?returnTo=/settings/integrations";
  if (provider === "jamie") return "/settings/jamie";
  if (provider === "imessage") return "/settings/imessage";
  if (provider === "granola") return "/settings/granola";
  if (provider === "fathom") return "/settings/fathom";
  if (provider === "attio") return "/settings/attio";
  if (provider === "stripe") return "/settings/stripe";
  if (provider === "slack") return "/api/integrations/slack/start?returnTo=/settings/integrations";
  if (provider === "hubspot")
    return "/api/integrations/hubspot/start?returnTo=/settings/integrations";
  if (provider === "latitude")
    return "/api/integrations/latitude/start?returnTo=/settings/integrations";
  if (provider === "neon") return "/api/integrations/neon/start?returnTo=/settings/integrations";
  if (provider === "posthog")
    return "/api/integrations/posthog/start?returnTo=/settings/integrations";
  if (provider === "x_account")
    return "/api/integrations/x-account/start?returnTo=/settings/integrations";
  return "/api/integrations/linear/start?returnTo=/settings/integrations";
}

function buttonLabel(status: string, isPending: boolean) {
  if (isPending) return "Working";
  if (status === "connected") return "Reconnect";
  if (status === "needs_reauth") return "Reconnect";
  if (status === "failed" || status === "expired") return "Retry";
  return "Connect";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
