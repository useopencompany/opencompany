"use client";

import type { GitHubActivityEventType } from "@opencompany/goat-brain";
import { toast } from "@opencompany/ui/components/sonner";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  type GoatBrainSourcesDetails,
  type GoatBrainSourceView,
  type GoatGitHubRepositoryListResult,
  type GoatLinearTeamListResult,
  type GoatSlackConversationListResult,
  getGoatBrainSourcesAction,
  listGoatGitHubRepositoriesAction,
  listGoatLinearTeamsAction,
  listGoatSlackConversationsAction,
  setGoatBrainGitHubSourceAction,
  setGoatBrainGmailSourceAction,
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
  const source = details?.sources.find((entry) => entry.provider === providerId) ?? null;
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
    enabled: source ? source.enabled : legacyEnabled,
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
}: {
  brainRef: string;
  provider: GoatBrainSourceProviderDef;
  details: GoatBrainSourcesDetails | null;
  onChanged: () => Promise<void>;
}) {
  const [isPending, startTransition] = useTransition();
  const Icon = provider.icon;
  const state = resolveGoatBrainSourceState(provider.id, details);
  const { source, connected, legacyEnabled, enabled } = state;

  const slack = provider.id === "slack" ? details?.slack : undefined;
  const linear = provider.id === "linear" ? details?.linear : undefined;
  const github = provider.id === "github" ? details?.github : undefined;
  const gmail = provider.id === "gmail" ? details?.gmail : undefined;
  const canToggle =
    provider.available && (source ? source.isOwnIntegration : connected) && !isPending;
  const sourceNeedsSetup = Boolean(
    source && source.integrationStatus !== "connected" && !(provider.id === "jamie" && connected),
  );
  const sourceStatusBadge =
    sourceNeedsSetup && source
      ? source.integrationStatus === "needs_reauth"
        ? "Needs setup"
        : "Sync issue"
      : null;

  const toggle = () => {
    const integrationId = state.integrationId;
    if (!integrationId) return;
    startTransition(async () => {
      const result = await setGoatBrainSourceEnabledAction({
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
      {source && !source.isOwnIntegration ? (
        <p className="text-[11.5px] leading-4 text-ink-subtle">
          Connected by {source.connectedByName}. Only they can change this source.
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
      (source ? source.isOwnIntegration : true) ? (
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
      (source ? source.isOwnIntegration : true) ? (
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
      (source ? source.isOwnIntegration : true) ? (
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
      (source ? source.isOwnIntegration : true) ? (
        <GmailSourceEditor
          brainRef={brainRef}
          integrationId={source?.integrationId ?? gmail.integration.integrationId}
          source={source}
          onChanged={onChanged}
        />
      ) : null}
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
            { id: record.id, name: typeof record.name === "string" ? record.name : record.id },
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
