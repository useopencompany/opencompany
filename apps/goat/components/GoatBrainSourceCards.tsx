"use client";

import type { GitHubActivityEventType } from "@opencompany/goat-brain";
import { toast } from "@opencompany/ui/components/sonner";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  Plus,
  Search,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  type GoatBrainSourcesDetails,
  type GoatBrainSourceView,
  type GoatGitHubRepositoryListResult,
  type GoatGoogleDriveResourceListResult,
  type GoatLinearTeamListResult,
  type GoatOwnSourceAccount,
  type GoatSlackConversationListResult,
  getGoatBrainSourcesAction,
  listGoatGitHubRepositoriesAction,
  listGoatGoogleDriveResourcesAction,
  listGoatLinearTeamsAction,
  listGoatSlackConversationsAction,
  removeGoatBrainSourceAction,
  setGoatBrainGitHubSourceAction,
  setGoatBrainGmailSourceAction,
  setGoatBrainGoogleDriveSourceAction,
  setGoatBrainLinearSourceAction,
  setGoatBrainSlackSourceAction,
  setGoatBrainSourceEnabledAction,
} from "@/lib/brain-source-actions";
import {
  GOAT_BRAIN_SOURCE_PROVIDERS,
  type GoatBrainSourceProviderDef,
} from "@/lib/brain-sources/registry";

export type GoatBrainSourceState = {
  source: GoatBrainSourceView | null;
  connected: boolean;
  legacyEnabled: boolean;
  enabled: boolean;
  integrationId: string | null;
};

export function resolveGoatBrainSourceState(
  providerId: GoatBrainSourceProviderDef["id"],
  details: GoatBrainSourcesDetails | null,
): GoatBrainSourceState {
  // A provider can now hold several sources (multiple members / multiple
  // accounts). This single-source view prefers the viewer's own row —
  // onboarding and the overview reason about "my connection" — and reports
  // enabled when ANY source of the provider feeds the brain.
  const providerSources = details?.sources.filter((entry) => entry.provider === providerId) ?? [];
  const source = providerSources.find((entry) => entry.isOwn) ?? providerSources[0] ?? null;
  const integration =
    providerId === "jamie"
      ? details?.jamie.integration
      : providerId === "slack"
        ? details?.slack.integration
        : providerId === "linear"
          ? details?.linear.integration
          : providerId === "github"
            ? details?.github.integration
            : providerId === "gmail"
              ? details?.gmail.integration
              : providerId === "google_drive"
                ? details?.googleDrive.integration
                : providerId === "granola"
                  ? details?.granola.integration
                  : undefined;
  const jamieReady =
    providerId === "jamie" ? Boolean(details?.jamie.integration.apiKeyConfigured) : false;
  const connected = providerId === "jamie" ? jamieReady : Boolean(integration?.connected);
  // Before any per-brain rows exist, Jamie deliveries follow legacy routing to
  // the user's default brain — surface that as an implicit "on" there.
  const legacyEnabled = Boolean(
    providerId === "jamie" &&
      !source &&
      details?.jamie.legacyDefaultDelivery &&
      details?.jamie.isDefaultBrain,
  );
  return {
    source,
    connected,
    legacyEnabled,
    enabled:
      providerSources.length > 0 ? providerSources.some((entry) => entry.enabled) : legacyEnabled,
    integrationId: source?.integrationId ?? integration?.integrationId ?? null,
  };
}

export function BrainSourcesSection({ brainRef }: { brainRef: string }) {
  const [details, setDetails] = useState<GoatBrainSourcesDetails | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    const next = await getGoatBrainSourcesAction(brainRef);
    setDetails(next);
    setLoaded(true);
  }, [brainRef]);

  useEffect(() => {
    let cancelled = false;
    void getGoatBrainSourcesAction(brainRef).then((next) => {
      if (cancelled) return;
      setDetails(next);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [brainRef]);

  if (!loaded) {
    return <div className="px-1 py-1.5 text-[12px] text-ink-subtle">Loading sources…</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="px-1 text-[12px] leading-5 text-ink-subtle">
        Connected sources feed new content into this brain automatically.
      </p>
      {GOAT_BRAIN_SOURCE_PROVIDERS.map((provider) => (
        <SourceProviderCard
          key={provider.id}
          brainRef={brainRef}
          provider={provider}
          details={details}
          onChanged={reload}
        />
      ))}
    </div>
  );
}

export function SourceProviderCard({
  brainRef,
  provider,
  details,
  onChanged,
  onConnect,
  connectPending = false,
  connectDisabled = false,
}: {
  brainRef: string;
  provider: GoatBrainSourceProviderDef;
  details: GoatBrainSourcesDetails | null;
  onChanged: () => Promise<void>;
  onConnect?: () => void;
  connectPending?: boolean;
  connectDisabled?: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const Icon = provider.icon;
  const state = resolveGoatBrainSourceState(provider.id, details);
  const { source, connected, legacyEnabled, enabled } = state;

  // Personal providers render one row per attached source (multiple members
  // and multiple accounts per member), each with its own toggle, editor, and
  // remove. Workspace-owned providers and empty personal cards keep the
  // classic single-state card below.
  const personalProvider = isPersonalSourceProvider(provider.id);
  const providerSources = (details?.sources ?? [])
    .filter((entry) => entry.provider === provider.id)
    .sort((a, b) => Number(b.isOwn) - Number(a.isOwn));
  if (personalProvider && providerSources.length > 0) {
    const anyEnabled = providerSources.some((entry) => entry.enabled);
    return (
      <div className="flex flex-col gap-1.5 rounded-md border border-ink/10 p-2.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink">
            <Icon size={15} strokeWidth={1.8} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-ink">{provider.name}</span>
              <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em] text-ink-subtle">
                {providerSources.length === 1
                  ? anyEnabled
                    ? "Feeding Brain"
                    : "Paused"
                  : `${providerSources.length} sources · ${providerSources.filter((entry) => entry.enabled).length} ingesting`}
              </span>
            </div>
            <p className="truncate text-[11.5px] leading-4 text-ink-subtle">
              {provider.description}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {providerSources.map((entry) => (
            <SourceRow
              key={entry.sourceId}
              brainRef={brainRef}
              provider={provider}
              source={entry}
              onChanged={onChanged}
            />
          ))}
        </div>
        <AddOwnAccountSection
          brainRef={brainRef}
          provider={provider}
          details={details}
          attachedIntegrationIds={new Set(providerSources.map((entry) => entry.integrationId))}
          onChanged={onChanged}
        />
      </div>
    );
  }

  const slack = provider.id === "slack" ? details?.slack : undefined;
  const linear = provider.id === "linear" ? details?.linear : undefined;
  const github = provider.id === "github" ? details?.github : undefined;
  const gmail = provider.id === "gmail" ? details?.gmail : undefined;
  const googleDrive = provider.id === "google_drive" ? details?.googleDrive : undefined;
  const canToggle =
    provider.available &&
    (source ? source.canToggle : connected) &&
    (provider.id !== "google_drive" || Boolean(source)) &&
    !isPending;
  const sourceNeedsSetup = Boolean(
    source && source.integrationStatus !== "connected" && !(provider.id === "jamie" && connected),
  );
  const sourceStatusBadge =
    sourceNeedsSetup && source
      ? source.integrationStatus === "disconnected"
        ? "Connection lost"
        : source.integrationStatus === "needs_reauth"
          ? "Needs setup"
          : "Sync issue"
      : enabled
        ? "Feeding Brain"
        : connected
          ? "Authorized"
          : null;

  const toggle = () => {
    const integrationId = state.integrationId;
    if (!integrationId) return;
    startTransition(async () => {
      const result =
        provider.id === "google_drive"
          ? await setGoatBrainGoogleDriveSourceAction({
              brainRef,
              integrationId,
              enabled: !enabled,
              resourceIds: googleDriveResourceIds(source?.config),
            })
          : await setGoatBrainSourceEnabledAction({
              brainRef,
              provider: provider.id,
              integrationId,
              enabled: !enabled,
            });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await onChanged();
    });
  };

  return (
    <div
      className={`flex flex-col gap-1.5 rounded-md border border-ink/10 p-2.5 ${
        provider.available ? "" : "opacity-55"
      }`}
    >
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink">
          <Icon size={15} strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-ink">{provider.name}</span>
            {!provider.available ? (
              <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em] text-ink-subtle">
                Coming soon
              </span>
            ) : null}
            {sourceStatusBadge ? (
              <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em] text-ink-subtle">
                {sourceStatusBadge}
              </span>
            ) : null}
          </div>
          <p className="truncate text-[11.5px] leading-4 text-ink-subtle">{provider.description}</p>
        </div>
        {provider.available ? (
          connected || source ? (
            <SourceToggle
              enabled={enabled}
              disabled={!canToggle}
              onToggle={toggle}
              label={`${provider.name} source`}
            />
          ) : onConnect ? (
            <button
              type="button"
              onClick={onConnect}
              disabled={connectDisabled || connectPending}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-ink/15 px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {connectPending ? (
                <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />
              ) : null}
              {connectPending
                ? "Connecting"
                : provider.connectionKind === "oauth"
                  ? "Connect"
                  : "Set up"}
            </button>
          ) : (
            <a
              href={provider.connectHref}
              className="shrink-0 rounded-md border border-ink/15 px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-surface-hover"
            >
              Connect
            </a>
          )
        ) : null}
      </div>
      {provider.docsHref ? (
        <a
          href={provider.docsHref}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1.5 text-[11.5px] font-medium text-ink-subtle transition-colors hover:text-ink"
        >
          <BookOpen size={12} strokeWidth={1.9} />
          Setup guide
          <ExternalLink size={11} strokeWidth={1.9} />
        </a>
      ) : null}
      {source && source.integrationStatus === "disconnected" ? (
        <p className="text-[11.5px] leading-4 text-ink-subtle">
          The connection behind this source is gone; ingestion is paused until it is reconnected.
        </p>
      ) : null}
      {source && !source.canConfigure ? (
        <p className="text-[11.5px] leading-4 text-ink-subtle">
          Connected by {source.connectedByName}. Only they can change this source.
        </p>
      ) : null}
      {source && source.ownerKind === "workspace" ? (
        <p className="text-[11.5px] leading-4 text-ink-subtle">
          Workspace integration · connected by {source.connectedByName}.
        </p>
      ) : null}
      {legacyEnabled ? (
        <p className="text-[11.5px] leading-4 text-ink-subtle">
          Delivering here as your default brain. Toggling any brain makes routing explicit.
        </p>
      ) : null}
      {provider.id === "slack" &&
      slack?.integration.integrationId &&
      (connected || source) &&
      (source ? source.canConfigure : true) ? (
        <SlackChannelPicker
          brainRef={brainRef}
          integrationId={source?.integrationId ?? slack.integration.integrationId}
          source={source}
          onChanged={onChanged}
        />
      ) : null}
      {provider.id === "linear" &&
      linear?.integration.integrationId &&
      (connected || source) &&
      (source ? source.canConfigure : true) ? (
        <LinearTeamPicker
          brainRef={brainRef}
          integrationId={source?.integrationId ?? linear.integration.integrationId}
          source={source}
          onChanged={onChanged}
        />
      ) : null}
      {provider.id === "github" &&
      github?.integration.integrationId &&
      (connected || source) &&
      (source ? source.canConfigure : true) ? (
        <GitHubRepoPicker
          brainRef={brainRef}
          integrationId={source?.integrationId ?? github.integration.integrationId}
          source={source}
          onChanged={onChanged}
        />
      ) : null}
      {provider.id === "gmail" &&
      gmail?.integration.integrationId &&
      (connected || source) &&
      (source ? source.canConfigure : true) ? (
        <GmailSourceEditor
          brainRef={brainRef}
          integrationId={source?.integrationId ?? gmail.integration.integrationId}
          source={source}
          onChanged={onChanged}
        />
      ) : null}
      {provider.id === "google_drive" &&
      googleDrive?.integration.integrationId &&
      (connected || source) &&
      (source ? source.canConfigure : true) ? (
        <GoogleDriveSourceEditor
          brainRef={brainRef}
          integrationId={source?.integrationId ?? googleDrive.integration.integrationId}
          source={source}
          onChanged={onChanged}
        />
      ) : null}
      {personalProvider ? (
        <AddOwnAccountSection
          brainRef={brainRef}
          provider={provider}
          details={details}
          // The zero state's inline editor already targets the primary own
          // account; only offer genuinely additional accounts here.
          attachedIntegrationIds={new Set([...(state.integrationId ? [state.integrationId] : [])])}
          onChanged={onChanged}
        />
      ) : null}
    </div>
  );
}

type GoatPersonalBrainSourceProvider = "slack" | "linear" | "gmail" | "google_drive" | "granola";

function isPersonalSourceProvider(
  providerId: GoatBrainSourceProviderDef["id"],
): providerId is GoatPersonalBrainSourceProvider {
  return (
    providerId === "slack" ||
    providerId === "linear" ||
    providerId === "gmail" ||
    providerId === "google_drive" ||
    providerId === "granola"
  );
}

// Wording shown before a member publishes one of their accounts into a shared
// brain — the consent moment.
const ADD_SOURCE_CONSENT_COPY: Record<GoatPersonalBrainSourceProvider, string> = {
  gmail:
    "Emails matching your filters — including what other people write to you — will be summarized into this brain. Everyone with access to this brain, now and in the future, can see what's captured.",
  slack:
    "Messages from the channels and DMs you select — including what other people write — will be summarized into this brain and visible to everyone with access to it.",
  google_drive:
    "Changes to the files and folders you select will be summarized into this brain and visible to everyone with access to it.",
  linear:
    "Issue and comment activity from the teams you select will be summarized into this brain and visible to everyone with access to it.",
  granola:
    "Your Granola meeting notes — including what other participants said — will be summarized into this brain and visible to everyone with access to it.",
};

const ADD_SOURCE_CONSENT_FOOTER =
  "Only you can change what's ingested. You or a workspace admin can pause or remove this source at any time.";

function sourceAccountLabel(source: GoatBrainSourceView): string | null {
  if (source.provider === "slack") {
    return (
      [source.connectionLabel, source.accountName].filter(Boolean).join(" · ") ||
      source.accountEmail
    );
  }
  if (source.provider === "linear") return source.connectionLabel ?? source.accountName;
  return source.accountEmail ?? source.accountName;
}

function ownAccountLabel(account: GoatOwnSourceAccount, provider: string): string {
  if (provider === "slack") {
    return (
      [account.connectionLabel, account.accountName].filter(Boolean).join(" · ") ||
      account.accountEmail ||
      account.integrationId
    );
  }
  if (provider === "linear") {
    return account.connectionLabel || account.accountName || account.integrationId;
  }
  return account.accountEmail || account.accountName || account.integrationId;
}

// One attached source of a personal provider: owner identity, the specific
// account, per-row toggle/remove, and — for the owner — the inline config
// editor. Admins see toggle/remove on other members' rows but never the
// editor; other members see a read-only row.
function SourceRow({
  brainRef,
  provider,
  source,
  onChanged,
}: {
  brainRef: string;
  provider: GoatBrainSourceProviderDef;
  source: GoatBrainSourceView;
  onChanged: () => Promise<void>;
}) {
  const [isPending, startTransition] = useTransition();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const accountLabel = sourceAccountLabel(source);
  const statusBadge =
    source.integrationStatus !== "connected"
      ? source.integrationStatus === "disconnected"
        ? "Connection lost"
        : source.integrationStatus === "needs_reauth"
          ? "Needs setup"
          : "Sync issue"
      : null;

  const toggle = () => {
    startTransition(async () => {
      const result = await setGoatBrainSourceEnabledAction({
        brainRef,
        provider: provider.id,
        integrationId: source.integrationId,
        enabled: !source.enabled,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await onChanged();
    });
  };

  const remove = () => {
    startTransition(async () => {
      const result = await removeGoatBrainSourceAction({
        brainRef,
        integrationId: source.integrationId,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setConfirmingRemove(false);
      await onChanged();
    });
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-ink/10 p-2">
      <div className="flex items-center gap-2">
        {source.ownerAvatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={source.ownerAvatarUrl}
            alt=""
            className="h-5 w-5 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-muted text-ink-subtle">
            <UserRound size={11} strokeWidth={2} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-medium text-ink">
              {source.isOwn ? "You" : source.connectedByName}
            </span>
            {accountLabel ? (
              <span className="truncate text-[11.5px] text-ink-subtle">· {accountLabel}</span>
            ) : null}
            {statusBadge ? (
              <span className="shrink-0 rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em] text-ink-subtle">
                {statusBadge}
              </span>
            ) : null}
          </div>
          <p className="truncate text-[11px] leading-4 text-ink-subtle">
            {source.isOwn
              ? "Connected by you"
              : source.canToggle
                ? `Managed by ${source.connectedByName} · only they can change what's ingested. You can pause or remove it.`
                : `Managed by ${source.connectedByName}`}
          </p>
        </div>
        {source.canRemove ? (
          <button
            type="button"
            onClick={() => setConfirmingRemove(true)}
            disabled={isPending}
            className="shrink-0 rounded-md px-1.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-60"
          >
            Remove
          </button>
        ) : null}
        <SourceToggle
          enabled={source.enabled}
          disabled={!source.canToggle || isPending}
          onToggle={toggle}
          label={`${provider.name} source`}
        />
      </div>
      {confirmingRemove ? (
        <div className="rounded-md border border-ink/10 bg-surface-muted px-2.5 py-2 text-[11.5px] leading-4 text-ink-muted">
          <span>
            Remove {source.isOwn ? "your" : `${source.connectedByName}'s`} {provider.name}
            {accountLabel ? ` (${accountLabel})` : ""} from this brain? Content already captured
            stays in the brain; new content stops flowing.
          </span>
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              type="button"
              onClick={remove}
              disabled={isPending}
              className="rounded-md border border-ink/15 px-2 py-0.5 text-[11.5px] font-medium text-warning transition-colors hover:bg-surface-hover disabled:opacity-60"
            >
              Remove source
            </button>
            <button
              type="button"
              onClick={() => setConfirmingRemove(false)}
              disabled={isPending}
              className="rounded-md px-2 py-0.5 text-[11.5px] text-ink-subtle transition-colors hover:bg-surface-hover"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {source.canConfigure && provider.id === "slack" ? (
        <SlackChannelPicker
          brainRef={brainRef}
          integrationId={source.integrationId}
          source={source}
          onChanged={onChanged}
        />
      ) : null}
      {source.canConfigure && provider.id === "linear" ? (
        <LinearTeamPicker
          brainRef={brainRef}
          integrationId={source.integrationId}
          source={source}
          onChanged={onChanged}
        />
      ) : null}
      {source.canConfigure && provider.id === "gmail" ? (
        <GmailSourceEditor
          brainRef={brainRef}
          integrationId={source.integrationId}
          source={source}
          onChanged={onChanged}
        />
      ) : null}
      {source.canConfigure && provider.id === "google_drive" ? (
        <GoogleDriveSourceEditor
          brainRef={brainRef}
          integrationId={source.integrationId}
          source={source}
          onChanged={onChanged}
        />
      ) : null}
    </div>
  );
}

// "Add your account as a source" — lists the viewer's connected accounts of
// this provider that aren't feeding the brain yet, with the consent framing
// shown before anything is attached.
function AddOwnAccountSection({
  brainRef,
  provider,
  details,
  attachedIntegrationIds,
  onChanged,
}: {
  brainRef: string;
  provider: GoatBrainSourceProviderDef;
  details: GoatBrainSourcesDetails | null;
  attachedIntegrationIds: Set<string>;
  onChanged: () => Promise<void>;
}) {
  const [pendingAccount, setPendingAccount] = useState<GoatOwnSourceAccount | null>(null);
  const [isPending, startTransition] = useTransition();
  if (!details || !isPersonalSourceProvider(provider.id)) return null;
  const addable = details.ownAccounts[provider.id].filter(
    (account) =>
      !attachedIntegrationIds.has(account.integrationId) && account.status === "connected",
  );
  if (addable.length === 0) return null;

  const add = (account: GoatOwnSourceAccount) => {
    startTransition(async () => {
      const result = await setGoatBrainSourceEnabledAction({
        brainRef,
        provider: provider.id,
        integrationId: account.integrationId,
        enabled: true,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setPendingAccount(null);
      toast.success(`${provider.name} added to this brain.`);
      await onChanged();
    });
  };

  return (
    <div className="flex flex-col gap-1.5 border-t border-ink/10 pt-2">
      {pendingAccount ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-ink/10 bg-surface-muted px-2.5 py-2">
          <span className="text-[12px] font-medium text-ink">
            Adding {ownAccountLabel(pendingAccount, provider.id)} to this brain
          </span>
          <p className="text-[11.5px] leading-4 text-ink-muted">
            {ADD_SOURCE_CONSENT_COPY[provider.id]}
          </p>
          <p className="text-[11.5px] leading-4 text-ink-subtle">{ADD_SOURCE_CONSENT_FOOTER}</p>
          <div className="mt-0.5 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => add(pendingAccount)}
              disabled={isPending}
              className="rounded-md bg-ink px-2.5 py-1 text-[12px] font-medium text-canvas transition-opacity disabled:opacity-60"
            >
              {isPending ? "Adding…" : "Add to brain"}
            </button>
            <button
              type="button"
              onClick={() => setPendingAccount(null)}
              disabled={isPending}
              className="rounded-md px-2 py-1 text-[12px] text-ink-subtle transition-colors hover:bg-surface-hover"
            >
              Not now
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {addable.map((account) => (
            <button
              key={account.integrationId}
              type="button"
              onClick={() => setPendingAccount(account)}
              className="inline-flex items-center gap-1 rounded-md border border-ink/15 px-2 py-1 text-[11.5px] font-medium text-ink transition-colors hover:bg-surface-hover"
            >
              <Plus size={11} strokeWidth={2} />
              Add {ownAccountLabel(account, provider.id)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type SlackConfigSelection = {
  channels: { id: string; name: string }[];
  dms: { id: string; name: string }[];
};

function slackSelectionFromConfig(
  config: Record<string, unknown> | undefined,
): SlackConfigSelection {
  const parse = (value: unknown) =>
    Array.isArray(value)
      ? value.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const record = entry as Record<string, unknown>;
          if (typeof record.id !== "string" || !record.id) return [];
          return [
            {
              id: record.id,
              name: typeof record.name === "string" ? record.name : record.id,
            },
          ];
        })
      : [];
  return { channels: parse(config?.channels), dms: parse(config?.dms) };
}

function SlackChannelPicker({
  brainRef,
  integrationId,
  source,
  onChanged,
}: {
  brainRef: string;
  integrationId: string;
  source: GoatBrainSourceView | null;
  onChanged: () => Promise<void>;
}) {
  const saved = useMemo(() => slackSelectionFromConfig(source?.config), [source]);
  const [expanded, setExpanded] = useState(false);
  const [conversations, setConversations] = useState<GoatSlackConversationListResult | null>(null);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<Map<string, { name: string; kind: "channel" | "dm" }>>(
    () => selectionFromSaved(saved),
  );
  const [dmsOpen, setDmsOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!expanded || conversations) return;
    let cancelled = false;
    void listGoatSlackConversationsAction(integrationId).then((result) => {
      if (!cancelled) setConversations(result);
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, conversations, integrationId]);

  const toggleConversation = (id: string, name: string, kind: "channel" | "dm") => {
    setDirty(true);
    setSelection((current) => {
      const next = new Map(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.set(id, { name, kind });
      }
      return next;
    });
  };

  const save = () => {
    startTransition(async () => {
      const channels: { id: string; name: string }[] = [];
      const dms: { id: string; name: string }[] = [];
      for (const [id, entry] of selection) {
        (entry.kind === "dm" ? dms : channels).push({ id, name: entry.name });
      }
      const result = await setGoatBrainSlackSourceAction({
        brainRef,
        integrationId,
        enabled: source ? source.enabled : true,
        channels,
        dms,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setDirty(false);
      toast.success("Slack channels updated.");
      await onChanged();
    });
  };

  const selectedCount = selection.size;
  const summary =
    selectedCount === 0
      ? "No channels selected yet — nothing is ingested until you choose some."
      : `${selectedCount} conversation${selectedCount === 1 ? "" : "s"} selected.`;

  if (!expanded) {
    return (
      <div className="flex items-center justify-between gap-2 border-t border-ink/10 pt-2">
        <p className="text-[11.5px] leading-4 text-ink-subtle">{summary}</p>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="shrink-0 rounded-md border border-ink/15 px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-surface-hover"
        >
          Choose channels
        </button>
      </div>
    );
  }

  const query = search.trim().toLowerCase();
  const channelOptions = (conversations?.ok ? conversations.channels : []).filter(
    (channel) => !query || channel.name.toLowerCase().includes(query),
  );
  const dmOptions = (conversations?.ok ? conversations.dms : []).filter(
    (dm) => !query || dm.name.toLowerCase().includes(query),
  );

  return (
    <div className="flex flex-col gap-2 border-t border-ink/10 pt-2">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            strokeWidth={2}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-subtle"
          />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search channels"
            className="w-full rounded-md border border-ink/10 bg-transparent py-1 pl-7 pr-2 text-[12.5px] text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          />
        </div>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
        >
          Collapse
        </button>
      </div>
      {conversations === null ? (
        <div className="px-1 py-1.5 text-[12px] text-ink-subtle">Loading conversations…</div>
      ) : !conversations.ok ? (
        <div className="px-1 py-1.5 text-[12px] text-warning">{conversations.error}</div>
      ) : (
        <>
          <div className="flex max-h-[220px] flex-col gap-px overflow-y-auto rounded-md border border-ink/10 p-1">
            {channelOptions.length === 0 ? (
              <div className="px-2 py-1.5 text-[12px] text-ink-subtle">No channels found.</div>
            ) : (
              channelOptions.map((channel) => (
                <label
                  key={channel.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover"
                >
                  <input
                    type="checkbox"
                    checked={selection.has(channel.id)}
                    onChange={() => toggleConversation(channel.id, channel.name, "channel")}
                    className="accent-ink"
                  />
                  <span className="min-w-0 flex-1 truncate">#{channel.name}</span>
                  {channel.isPrivate ? (
                    <span className="shrink-0 text-[11px] text-ink-subtle">private</span>
                  ) : null}
                </label>
              ))
            )}
          </div>
          <div className="rounded-md border border-ink/10">
            <button
              type="button"
              onClick={() => setDmsOpen((open) => !open)}
              className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-hover"
            >
              {dmsOpen ? (
                <ChevronDown size={13} strokeWidth={2} />
              ) : (
                <ChevronRight size={13} strokeWidth={2} />
              )}
              Direct messages
            </button>
            {dmsOpen ? (
              <div className="flex flex-col gap-1 px-2 pb-2">
                <p className="text-[11.5px] leading-4 text-ink-subtle">
                  Messages in the DMs you select — including what other people write to you — are
                  ingested into this brain and visible to everyone with access to it.
                </p>
                <div className="flex max-h-[180px] flex-col gap-px overflow-y-auto">
                  {dmOptions.length === 0 ? (
                    <div className="px-1 py-1 text-[12px] text-ink-subtle">No DMs found.</div>
                  ) : (
                    dmOptions.map((dm) => (
                      <label
                        key={dm.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover"
                      >
                        <input
                          type="checkbox"
                          checked={selection.has(dm.id)}
                          onChange={() => toggleConversation(dm.id, dm.name, "dm")}
                          className="accent-ink"
                        />
                        <span className="min-w-0 flex-1 truncate">{dm.name}</span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            ) : null}
          </div>
          {conversations.partial ? (
            <p className="text-[11.5px] leading-4 text-ink-subtle">
              Some conversations could not be loaded from Slack — try again in a minute.
            </p>
          ) : null}
        </>
      )}
      {dirty ? (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={isPending}
            onClick={save}
            className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-60"
          >
            {isPending ? "Saving…" : "Save channels"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function githubReposFromConfig(
  config: Record<string, unknown> | undefined,
): { id: string; fullName: string }[] {
  const value = config?.repos;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id) return [];
    return [
      {
        id: record.id,
        fullName: typeof record.fullName === "string" ? record.fullName : record.id,
      },
    ];
  });
}

// Kept as literals so this client component has no runtime import from the
// goat-brain package; the set must mirror GITHUB_ACTIVITY_EVENT_TYPES.
const GITHUB_EVENT_OPTIONS: { id: GitHubActivityEventType; label: string }[] = [
  { id: "pull_request_opened", label: "Pull request opened" },
  { id: "pull_request_merged", label: "Pull request merged" },
  { id: "pull_request_commented", label: "Pull request comment" },
  { id: "issue_opened", label: "Issue created" },
  { id: "issue_commented", label: "Issue comment" },
];

function githubEventsFromConfig(
  config: Record<string, unknown> | undefined,
): Set<GitHubActivityEventType> {
  const known = new Set(GITHUB_EVENT_OPTIONS.map((option) => option.id));
  const value = config?.events;
  // Missing key (pre-filter configs or a fresh source) means all event types,
  // matching the webhook router's default.
  if (!Array.isArray(value)) return new Set(known);
  return new Set(
    value.filter(
      (entry): entry is GitHubActivityEventType =>
        typeof entry === "string" && known.has(entry as GitHubActivityEventType),
    ),
  );
}

function GitHubRepoPicker({
  brainRef,
  integrationId,
  source,
  onChanged,
}: {
  brainRef: string;
  integrationId: string;
  source: GoatBrainSourceView | null;
  onChanged: () => Promise<void>;
}) {
  const saved = useMemo(() => githubReposFromConfig(source?.config), [source]);
  const savedEvents = useMemo(() => githubEventsFromConfig(source?.config), [source]);
  const [expanded, setExpanded] = useState(false);
  const [repos, setRepos] = useState<GoatGitHubRepositoryListResult | null>(null);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<Map<string, string>>(
    () => new Map(saved.map((repo) => [repo.id, repo.fullName])),
  );
  const [events, setEvents] = useState<Set<GitHubActivityEventType>>(() => new Set(savedEvents));
  const [dirty, setDirty] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!expanded || repos) return;
    let cancelled = false;
    void listGoatGitHubRepositoriesAction(integrationId).then((result) => {
      if (!cancelled) setRepos(result);
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, repos, integrationId]);

  const toggleRepo = (id: string, fullName: string) => {
    setDirty(true);
    setSelection((current) => {
      const next = new Map(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.set(id, fullName);
      }
      return next;
    });
  };

  const toggleEvent = (id: GitHubActivityEventType) => {
    setDirty(true);
    setEvents((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const save = () => {
    startTransition(async () => {
      const result = await setGoatBrainGitHubSourceAction({
        brainRef,
        integrationId,
        enabled: source ? source.enabled : true,
        repos: [...selection].map(([id, fullName]) => ({ id, fullName })),
        events: [...events],
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setDirty(false);
      toast.success("GitHub source updated.");
      await onChanged();
    });
  };

  const selectedCount = selection.size;
  const eventSummary =
    events.size === 0
      ? "no events"
      : GITHUB_EVENT_OPTIONS.filter((option) => events.has(option.id))
          .map((option) => option.label.toLowerCase())
          .join(", ");
  const summary =
    selectedCount === 0
      ? "No repositories selected yet — nothing is ingested until you choose some."
      : `${selectedCount} repositor${selectedCount === 1 ? "y" : "ies"} selected · ${eventSummary}.`;

  if (!expanded) {
    return (
      <div className="flex items-center justify-between gap-2 border-t border-ink/10 pt-2">
        <p className="text-[11.5px] leading-4 text-ink-subtle">{summary}</p>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="shrink-0 rounded-md border border-ink/15 px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-surface-hover"
        >
          Configure
        </button>
      </div>
    );
  }

  const query = search.trim().toLowerCase();
  const repoOptions = (repos?.ok ? repos.repos : []).filter(
    (repo) => !query || repo.fullName.toLowerCase().includes(query),
  );

  return (
    <div className="flex flex-col gap-2 border-t border-ink/10 pt-2">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            strokeWidth={2}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-subtle"
          />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search repositories"
            className="w-full rounded-md border border-ink/10 bg-transparent py-1 pl-7 pr-2 text-[12.5px] text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          />
        </div>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
        >
          Collapse
        </button>
      </div>
      {repos === null ? (
        <div className="px-1 py-1.5 text-[12px] text-ink-subtle">Loading repositories…</div>
      ) : !repos.ok ? (
        <div className="px-1 py-1.5 text-[12px] text-warning">{repos.error}</div>
      ) : (
        <div className="flex max-h-[220px] flex-col gap-px overflow-y-auto rounded-md border border-ink/10 p-1">
          {repoOptions.length === 0 ? (
            <div className="px-2 py-1.5 text-[12px] text-ink-subtle">No repositories found.</div>
          ) : (
            repoOptions.map((repo) => (
              <label
                key={repo.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover"
              >
                <input
                  type="checkbox"
                  checked={selection.has(repo.id)}
                  onChange={() => toggleRepo(repo.id, repo.fullName)}
                  className="accent-ink"
                />
                <span className="min-w-0 flex-1 truncate">{repo.fullName}</span>
                {repo.private ? (
                  <span className="shrink-0 text-[11px] text-ink-subtle">private</span>
                ) : null}
              </label>
            ))
          )}
        </div>
      )}
      <div className="flex flex-col gap-1 rounded-md border border-ink/10 p-2">
        <p className="text-[12px] font-medium text-ink">Events to ingest</p>
        {GITHUB_EVENT_OPTIONS.map((option) => (
          <label
            key={option.id}
            className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover"
          >
            <input
              type="checkbox"
              checked={events.has(option.id)}
              onChange={() => toggleEvent(option.id)}
              className="accent-ink"
            />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
          </label>
        ))}
        {events.size === 0 ? (
          <p className="text-[11.5px] leading-4 text-ink-subtle">
            No events selected — nothing is ingested from the chosen repositories.
          </p>
        ) : null}
      </div>
      {dirty ? (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={isPending}
            onClick={save}
            className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-60"
          >
            {isPending ? "Saving…" : "Save GitHub source"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function selectionFromSaved(saved: SlackConfigSelection) {
  const map = new Map<string, { name: string; kind: "channel" | "dm" }>();
  for (const channel of saved.channels)
    map.set(channel.id, { name: channel.name, kind: "channel" });
  for (const dm of saved.dms) map.set(dm.id, { name: dm.name, kind: "dm" });
  return map;
}

type LinearTeamSelection = { id: string; name: string; key?: string };
type LinearEventSelection =
  | "issue_created"
  | "issue_updated"
  | "issue_status_changed"
  | "issue_removed"
  | "comment_created"
  | "comment_updated";

const LINEAR_EVENT_OPTIONS: Array<{ id: LinearEventSelection; label: string }> = [
  { id: "issue_created", label: "Issue created" },
  { id: "issue_status_changed", label: "Status changed" },
  { id: "issue_updated", label: "Issue updated" },
  { id: "issue_removed", label: "Issue removed" },
  { id: "comment_created", label: "Comment added" },
  { id: "comment_updated", label: "Comment updated" },
];

function linearTeamsFromConfig(config: Record<string, unknown> | undefined): LinearTeamSelection[] {
  const value = config?.teams;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id) return [];
    return [
      {
        id: record.id,
        name: typeof record.name === "string" ? record.name : record.id,
        ...(typeof record.key === "string" && record.key ? { key: record.key } : {}),
      },
    ];
  });
}

function linearEventsFromConfig(
  config: Record<string, unknown> | undefined,
): LinearEventSelection[] {
  const value = config?.events;
  if (!Array.isArray(value)) return LINEAR_EVENT_OPTIONS.map((option) => option.id);
  const allowed = new Set(LINEAR_EVENT_OPTIONS.map((option) => option.id));
  const seen = new Set<LinearEventSelection>();
  for (const entry of value) {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).id
          : null;
    if (typeof id !== "string" || !allowed.has(id as LinearEventSelection)) continue;
    seen.add(id as LinearEventSelection);
  }
  return [...seen];
}

function LinearTeamPicker({
  brainRef,
  integrationId,
  source,
  onChanged,
}: {
  brainRef: string;
  integrationId: string;
  source: GoatBrainSourceView | null;
  onChanged: () => Promise<void>;
}) {
  const saved = useMemo(() => linearTeamsFromConfig(source?.config), [source]);
  const savedEvents = useMemo(() => linearEventsFromConfig(source?.config), [source]);
  const [expanded, setExpanded] = useState(false);
  const [teams, setTeams] = useState<GoatLinearTeamListResult | null>(null);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<Map<string, { name: string; key?: string }>>(
    () =>
      new Map(
        saved.map((team) => [team.id, { name: team.name, ...(team.key ? { key: team.key } : {}) }]),
      ),
  );
  const [eventSelection, setEventSelection] = useState<Set<LinearEventSelection>>(
    () => new Set(savedEvents),
  );
  const [dirty, setDirty] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!expanded || teams) return;
    let cancelled = false;
    void listGoatLinearTeamsAction(integrationId).then((result) => {
      if (!cancelled) setTeams(result);
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, teams, integrationId]);

  const toggleTeam = (id: string, name: string, key?: string) => {
    setDirty(true);
    setSelection((current) => {
      const next = new Map(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.set(id, { name, ...(key ? { key } : {}) });
      }
      return next;
    });
  };

  const toggleEvent = (eventId: LinearEventSelection) => {
    setDirty(true);
    setEventSelection((current) => {
      const next = new Set(current);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  };

  const save = () => {
    startTransition(async () => {
      const result = await setGoatBrainLinearSourceAction({
        brainRef,
        integrationId,
        enabled: source ? source.enabled : true,
        teams: [...selection].map(([id, entry]) => ({
          id,
          name: entry.name,
          ...(entry.key ? { key: entry.key } : {}),
        })),
        events: [...eventSelection].map((id) => ({ id })),
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setDirty(false);
      toast.success("Linear teams updated.");
      await onChanged();
    });
  };

  const selectedCount = selection.size;
  const selectedEventCount = eventSelection.size;
  const summary =
    selectedCount === 0
      ? "No teams selected yet — nothing is ingested until you choose some."
      : `${selectedCount} team${selectedCount === 1 ? "" : "s"} and ${selectedEventCount} event${
          selectedEventCount === 1 ? "" : "s"
        } selected.`;

  if (!expanded) {
    return (
      <div className="flex items-center justify-between gap-2 border-t border-ink/10 pt-2">
        <p className="text-[11.5px] leading-4 text-ink-subtle">{summary}</p>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="shrink-0 rounded-md border border-ink/15 px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-surface-hover"
        >
          Choose teams and events
        </button>
      </div>
    );
  }

  const query = search.trim().toLowerCase();
  const teamOptions = (teams?.ok ? teams.teams : []).filter(
    (team) =>
      !query ||
      team.name.toLowerCase().includes(query) ||
      (team.key ?? "").toLowerCase().includes(query),
  );

  return (
    <div className="flex flex-col gap-2 border-t border-ink/10 pt-2">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            strokeWidth={2}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-subtle"
          />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search teams"
            className="w-full rounded-md border border-ink/10 bg-transparent py-1 pl-7 pr-2 text-[12.5px] text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          />
        </div>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
        >
          Collapse
        </button>
      </div>
      {teams === null ? (
        <div className="px-1 py-1.5 text-[12px] text-ink-subtle">Loading teams…</div>
      ) : !teams.ok ? (
        <div className="px-1 py-1.5 text-[12px] text-warning">{teams.error}</div>
      ) : (
        <>
          <div className="flex max-h-[220px] flex-col gap-px overflow-y-auto rounded-md border border-ink/10 p-1">
            {teamOptions.length === 0 ? (
              <div className="px-2 py-1.5 text-[12px] text-ink-subtle">No teams found.</div>
            ) : (
              teamOptions.map((team) => (
                <label
                  key={team.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover"
                >
                  <input
                    type="checkbox"
                    checked={selection.has(team.id)}
                    onChange={() => toggleTeam(team.id, team.name, team.key)}
                    className="accent-ink"
                  />
                  <span className="min-w-0 flex-1 truncate">{team.name}</span>
                  {team.key ? (
                    <span className="shrink-0 text-[11px] text-ink-subtle">{team.key}</span>
                  ) : null}
                </label>
              ))
            )}
          </div>
          <div className="flex flex-col gap-1 rounded-md border border-ink/10 p-1">
            <div className="px-1 py-0.5 text-[12px] font-medium text-ink">Events</div>
            <div className="grid grid-cols-1 gap-px sm:grid-cols-2">
              {LINEAR_EVENT_OPTIONS.map((option) => (
                <label
                  key={option.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover"
                >
                  <input
                    type="checkbox"
                    checked={eventSelection.has(option.id)}
                    onChange={() => toggleEvent(option.id)}
                    className="accent-ink"
                  />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                </label>
              ))}
            </div>
          </div>
          <p className="text-[11.5px] leading-4 text-ink-subtle">
            Selected Linear activity in the teams you choose is ingested into this brain and visible
            to everyone with access to it.
          </p>
          {teams.partial ? (
            <p className="text-[11.5px] leading-4 text-ink-subtle">
              Some teams could not be loaded from Linear — try again in a minute.
            </p>
          ) : null}
        </>
      )}
      {dirty ? (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={isPending}
            onClick={save}
            className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-60"
          >
            {isPending ? "Saving…" : "Save Linear source"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

type GmailEventSelection = "email_received" | "email_sent";

const GMAIL_EVENT_OPTIONS: Array<{ id: GmailEventSelection; label: string }> = [
  { id: "email_received", label: "Email received" },
  { id: "email_sent", label: "Email sent" },
];

const GMAIL_INSTRUCTIONS_MAX_LENGTH = 2000;

function gmailEventsFromConfig(config: Record<string, unknown> | undefined): GmailEventSelection[] {
  const value = config?.events;
  if (!Array.isArray(value)) return GMAIL_EVENT_OPTIONS.map((option) => option.id);
  const allowed = new Set(GMAIL_EVENT_OPTIONS.map((option) => option.id));
  const seen = new Set<GmailEventSelection>();
  for (const entry of value) {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).id
          : null;
    if (typeof id !== "string" || !allowed.has(id as GmailEventSelection)) continue;
    seen.add(id as GmailEventSelection);
  }
  return [...seen];
}

function gmailInstructionsFromConfig(config: Record<string, unknown> | undefined): string {
  const value = config?.instructions;
  return typeof value === "string" ? value : "";
}

function GmailSourceEditor({
  brainRef,
  integrationId,
  source,
  onChanged,
}: {
  brainRef: string;
  integrationId: string;
  source: GoatBrainSourceView | null;
  onChanged: () => Promise<void>;
}) {
  const savedEvents = useMemo(() => gmailEventsFromConfig(source?.config), [source]);
  const savedInstructions = useMemo(() => gmailInstructionsFromConfig(source?.config), [source]);
  const [expanded, setExpanded] = useState(false);
  const [eventSelection, setEventSelection] = useState<Set<GmailEventSelection>>(
    () => new Set(savedEvents),
  );
  const [instructions, setInstructions] = useState(savedInstructions);
  const [dirty, setDirty] = useState(false);
  const [isPending, startTransition] = useTransition();

  const toggleEvent = (eventId: GmailEventSelection) => {
    setDirty(true);
    setEventSelection((current) => {
      const next = new Set(current);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  };

  const save = () => {
    startTransition(async () => {
      const result = await setGoatBrainGmailSourceAction({
        brainRef,
        integrationId,
        enabled: source ? source.enabled : true,
        events: [...eventSelection].map((id) => ({ id })),
        instructions,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setDirty(false);
      toast.success("Gmail source updated.");
      await onChanged();
    });
  };

  const selectedLabels = GMAIL_EVENT_OPTIONS.filter((option) => eventSelection.has(option.id)).map(
    (option) => option.label.toLowerCase(),
  );
  const summary =
    selectedLabels.length === 0
      ? "No email events selected yet - nothing is ingested until you choose some."
      : `Ingesting ${selectedLabels.join(" and ")}${
          savedInstructions.trim() ? ", tuned by your instructions" : ""
        }.`;

  if (!expanded) {
    return (
      <div className="flex items-center justify-between gap-2 border-t border-ink/10 pt-2">
        <p className="text-[11.5px] leading-4 text-ink-subtle">{summary}</p>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="shrink-0 rounded-md border border-ink/15 px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-surface-hover"
        >
          Choose events and instructions
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-ink/10 pt-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-ink">Email ingestion</span>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
        >
          Collapse
        </button>
      </div>
      <div className="flex flex-col gap-1 rounded-md border border-ink/10 p-1">
        <div className="px-1 py-0.5 text-[12px] font-medium text-ink">Events</div>
        <div className="grid grid-cols-1 gap-px sm:grid-cols-2">
          {GMAIL_EVENT_OPTIONS.map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover"
            >
              <input
                type="checkbox"
                checked={eventSelection.has(option.id)}
                onChange={() => toggleEvent(option.id)}
                className="accent-ink"
              />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label
          htmlFor={`gmail-instructions-${brainRef}`}
          className="px-1 text-[12px] font-medium text-ink"
        >
          Ingestion instructions (optional)
        </label>
        <textarea
          id={`gmail-instructions-${brainRef}`}
          value={instructions}
          maxLength={GMAIL_INSTRUCTIONS_MAX_LENGTH}
          rows={3}
          onChange={(event) => {
            setInstructions(event.target.value);
            setDirty(true);
          }}
          placeholder="Ignore transactional and automated messages; only capture investor and customer emails."
          className="w-full resize-y rounded-md border border-ink/10 bg-transparent px-2 py-1.5 text-[12.5px] leading-5 text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        />
        <p className="px-1 text-[11.5px] leading-4 text-ink-subtle">
          Tell the ingestion agent what matters in your inbox. It reads every selected email event
          and uses these instructions to decide what to remember and what to skip - newsletters,
          receipts, and other noise are skipped by default.
        </p>
      </div>
      <p className="text-[11.5px] leading-4 text-ink-subtle">
        Ingested email content - including what other people write to you - is captured into this
        brain and visible to everyone with access to it.
      </p>
      {dirty ? (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={isPending}
            onClick={save}
            className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-60"
          >
            {isPending ? "Saving..." : "Save Gmail source"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

type GoogleDriveSelection = {
  id: string;
  name: string;
  kind: "file" | "folder";
  mimeType: string;
  driveId: string | null;
  webViewLink: string | null;
};

function googleDriveSelectionsFromConfig(
  config: Record<string, unknown> | undefined,
): GoogleDriveSelection[] {
  const resources = config?.resources;
  if (!Array.isArray(resources)) return [];
  return resources.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      typeof row.name !== "string" ||
      typeof row.mimeType !== "string" ||
      (row.kind !== "file" && row.kind !== "folder")
    ) {
      return [];
    }
    return [
      {
        id: row.id,
        name: row.name,
        kind: row.kind,
        mimeType: row.mimeType,
        driveId: typeof row.driveId === "string" ? row.driveId : null,
        webViewLink: typeof row.webViewLink === "string" ? row.webViewLink : null,
      },
    ];
  });
}

function googleDriveResourceIds(config: Record<string, unknown> | undefined) {
  return googleDriveSelectionsFromConfig(config).map((resource) => resource.id);
}

function GoogleDriveSourceEditor({
  brainRef,
  integrationId,
  source,
  onChanged,
}: {
  brainRef: string;
  integrationId: string;
  source: GoatBrainSourceView | null;
  onChanged: () => Promise<void>;
}) {
  const saved = useMemo(() => googleDriveSelectionsFromConfig(source?.config), [source]);
  const [expanded, setExpanded] = useState(false);
  const [selection, setSelection] = useState<Map<string, GoogleDriveSelection>>(
    () => new Map(saved.map((resource) => [resource.id, resource])),
  );
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ id: string; name: string }>>([]);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<GoatGoogleDriveResourceListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [isPending, startTransition] = useTransition();
  const currentFolder = breadcrumbs.at(-1);

  const load = useCallback(
    async (options: {
      parentId?: string;
      query?: string;
      pageToken?: string;
      append?: boolean;
    }) => {
      setLoading(true);
      try {
        const next = await listGoatGoogleDriveResourcesAction({
          integrationId,
          ...(options.parentId ? { parentId: options.parentId } : {}),
          ...(options.query?.trim() ? { query: options.query.trim() } : {}),
          ...(options.pageToken ? { pageToken: options.pageToken } : {}),
        });
        setResult((current) => {
          if (!options.append || !current?.ok || !next.ok) return next;
          return {
            ok: true,
            files: [...current.files, ...next.files],
            nextPageToken: next.nextPageToken,
          };
        });
      } finally {
        setLoading(false);
      }
    },
    [integrationId],
  );

  const toggleExpanded = () => {
    if (!expanded && !result) void load({});
    setExpanded((value) => !value);
  };

  const openFolder = (folder: GoogleDriveSelection) => {
    const nextBreadcrumbs = [...breadcrumbs, { id: folder.id, name: folder.name }];
    setBreadcrumbs(nextBreadcrumbs);
    setQuery("");
    void load({ parentId: folder.id });
  };

  const goToBreadcrumb = (index: number) => {
    const next = index < 0 ? [] : breadcrumbs.slice(0, index + 1);
    setBreadcrumbs(next);
    setQuery("");
    void load({ ...(next.at(-1)?.id ? { parentId: next.at(-1)!.id } : {}) });
  };

  const toggle = (resource: GoogleDriveSelection) => {
    setSelection((current) => {
      const next = new Map(current);
      if (next.has(resource.id)) next.delete(resource.id);
      else next.set(resource.id, resource);
      return next;
    });
    setDirty(true);
  };

  const save = () => {
    startTransition(async () => {
      const result = await setGoatBrainGoogleDriveSourceAction({
        brainRef,
        integrationId,
        enabled: selection.size > 0,
        resourceIds: [...selection.keys()],
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setDirty(false);
      toast.success("Google Drive source updated.");
      await onChanged();
    });
  };

  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-ink/10 pt-2">
      <button
        type="button"
        onClick={toggleExpanded}
        className="flex items-center gap-1 text-left text-[12px] font-medium text-ink"
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Select files and folders ({selection.size})
      </button>
      {expanded ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1 text-[11.5px] text-ink-subtle">
            <button type="button" onClick={() => goToBreadcrumb(-1)} className="hover:text-ink">
              Drive
            </button>
            {breadcrumbs.map((crumb, index) => (
              <span key={crumb.id} className="flex items-center gap-1">
                <span>/</span>
                <button
                  type="button"
                  onClick={() => goToBreadcrumb(index)}
                  className="max-w-40 truncate hover:text-ink"
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </div>
          <form
            className="flex gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void load({
                ...(currentFolder ? { parentId: currentFolder.id } : {}),
                ...(query.trim() ? { query } : {}),
              });
            }}
          >
            <div className="relative flex-1">
              <Search
                size={13}
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-subtle"
              />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search this folder"
                className="w-full rounded-md border border-ink/10 bg-transparent py-1.5 pl-7 pr-2 text-[12px] text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="rounded-md border border-ink/15 px-2.5 text-[12px] font-medium text-ink disabled:opacity-60"
            >
              Search
            </button>
          </form>
          <div className="max-h-64 overflow-y-auto rounded-md border border-ink/10">
            {loading && !result ? (
              <p className="px-3 py-3 text-[12px] text-ink-subtle">Loading Drive…</p>
            ) : result && !result.ok ? (
              <p className="px-3 py-3 text-[12px] text-warning">{result.error}</p>
            ) : result?.ok && result.files.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-ink-subtle">No files found.</p>
            ) : result?.ok ? (
              <>
                {result.files.map((file) => (
                  <div
                    key={file.id}
                    className="flex items-center gap-2 border-b border-ink/10 px-2.5 py-2 last:border-b-0"
                  >
                    <input
                      type="checkbox"
                      checked={selection.has(file.id)}
                      onChange={() => toggle(file)}
                      aria-label={`Select ${file.name}`}
                      className="h-3.5 w-3.5 accent-ink"
                    />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                      {file.name}
                    </span>
                    {file.kind === "folder" ? (
                      <>
                        <span className="text-[10.5px] text-ink-subtle">Recursive</span>
                        <button
                          type="button"
                          onClick={() => openFolder(file)}
                          className="text-[11.5px] font-medium text-ink-subtle hover:text-ink"
                        >
                          Open
                        </button>
                      </>
                    ) : null}
                  </div>
                ))}
                {result.nextPageToken ? (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() =>
                      void load({
                        ...(currentFolder ? { parentId: currentFolder.id } : {}),
                        ...(query.trim() ? { query } : {}),
                        ...(result.nextPageToken ? { pageToken: result.nextPageToken } : {}),
                        append: true,
                      })
                    }
                    className="w-full px-3 py-2 text-[11.5px] font-medium text-ink-subtle hover:text-ink disabled:opacity-60"
                  >
                    {loading ? "Loading…" : "Load more"}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
          {selection.size > 0 ? (
            <div className="flex flex-wrap gap-1">
              {[...selection.values()].map((resource) => (
                <button
                  type="button"
                  key={resource.id}
                  onClick={() => toggle(resource)}
                  className="max-w-full truncate rounded-full bg-surface-muted px-2 py-0.5 text-[10.5px] text-ink-subtle"
                  title={`Remove ${resource.name}`}
                >
                  {resource.name} ×
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <p className="text-[11.5px] leading-4 text-ink-subtle">
        Selected Drive content will be summarized into this brain and visible to everyone who can
        access it. Existing content is not imported until it changes after selection.
      </p>
      {dirty ? (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={isPending}
            onClick={save}
            className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-60"
          >
            {isPending ? "Saving..." : "Save Google Drive source"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SourceToggle({
  enabled,
  disabled,
  onToggle,
  label,
}: {
  enabled: boolean;
  disabled: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50 ${
        enabled ? "bg-ink" : "bg-ink/15"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-canvas transition-[left] duration-150 ${
          enabled ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}
