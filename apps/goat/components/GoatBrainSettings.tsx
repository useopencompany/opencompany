"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { Brain, Check, ChevronDown, ChevronRight, Copy, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import type { GoatBrainSummaryView, GoatWorkspaceView } from "@/components/GoatAppDataProvider";
import { VisibilityOption } from "@/components/GoatBrainSwitcher";
import { useHydrated } from "@/components/useHydrated";
import {
  type GoatBrainSourcesDetails,
  type GoatBrainSourceView,
  type GoatSlackConversationListResult,
  getGoatBrainSourcesAction,
  listGoatSlackConversationsAction,
  setGoatBrainSlackSourceAction,
  setGoatBrainSourceEnabledAction,
} from "@/lib/brain-source-actions";
import {
  GOAT_BRAIN_SOURCE_PROVIDERS,
  type GoatBrainSourceProviderDef,
} from "@/lib/brain-sources/registry";
import {
  type GoatWorkspaceMemberView,
  getGoatBrainAccessDetailsAction,
  setGoatBrainAccessAction,
} from "@/lib/workspace-actions";

export function GoatBrainSettings({
  brain,
  workspace,
}: {
  brain: GoatBrainSummaryView;
  workspace: GoatWorkspaceView;
}) {
  return (
    <div className="flex w-full flex-col gap-8">
      <header className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted text-ink">
          <Brain size={21} strokeWidth={2} />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-[34px] font-semibold leading-tight tracking-normal text-ink">
            {brain.name}
          </h1>
          <p className="text-[13px] leading-5 text-ink-subtle">Brain settings</p>
        </div>
      </header>

      <SettingsSection title="Access">
        <BrainAccessSection brain={brain} workspace={workspace} />
      </SettingsSection>

      <SettingsSection title="Claude connector">
        <ClaudeConnectorBlock brainRef={brain.id} />
      </SettingsSection>

      <SettingsSection title="Sources">
        <BrainSourcesSection brainRef={brain.id} />
      </SettingsSection>
    </div>
  );
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
        {title}
      </h2>
      {children}
    </section>
  );
}

function BrainAccessSection({
  brain,
  workspace,
}: {
  brain: GoatBrainSummaryView;
  workspace: GoatWorkspaceView;
}) {
  const [visibility, setVisibility] = useState<"workspace" | "restricted">(brain.visibility);
  const [members, setMembers] = useState<GoatWorkspaceMemberView[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    void getGoatBrainAccessDetailsAction(brain.id).then((details) => {
      if (cancelled || !details) return;
      setVisibility(details.visibility);
      setMembers(details.workspaceMembers);
      setSelected(new Set(details.memberWorkosIds));
    });
    return () => {
      cancelled = true;
    };
  }, [brain.id]);

  const toggleMember = (userWorkosId: string) => {
    setDirty(true);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(userWorkosId)) {
        next.delete(userWorkosId);
      } else {
        next.add(userWorkosId);
      }
      return next;
    });
  };

  const save = () => {
    startTransition(async () => {
      const result = await setGoatBrainAccessAction({
        brainRef: brain.id,
        visibility,
        memberWorkosIds: [...selected],
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setDirty(false);
      toast.success("Brain access updated.");
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <VisibilityOption
          checked={visibility === "workspace"}
          onSelect={() => {
            setVisibility("workspace");
            setDirty(true);
          }}
          title={`Everyone in ${workspace.name}`}
          description="All current and future members can view and edit."
        />
        <VisibilityOption
          checked={visibility === "restricted"}
          onSelect={() => {
            setVisibility("restricted");
            setDirty(true);
          }}
          title="Only specific members"
          description="Pick who can view and edit this brain."
        />
      </div>
      {visibility === "restricted" ? (
        <div className="flex max-h-[240px] flex-col gap-px overflow-y-auto rounded-md border border-ink/10 p-1">
          {members === null ? (
            <div className="px-2 py-1.5 text-[12px] text-ink-subtle">Loading members…</div>
          ) : (
            members.map((member) => (
              <label
                key={member.userWorkosId}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover"
              >
                <input
                  type="checkbox"
                  checked={selected.has(member.userWorkosId)}
                  onChange={() => toggleMember(member.userWorkosId)}
                  className="accent-ink"
                />
                <span className="min-w-0 flex-1 truncate">{member.name}</span>
                <span className="shrink-0 text-[11px] text-ink-subtle">{member.role}</span>
              </label>
            ))
          )}
        </div>
      ) : null}
      {dirty ? (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={isPending}
            onClick={save}
            className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-60"
          >
            {isPending ? "Saving…" : "Save access"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ClaudeConnectorBlock({ brainRef }: { brainRef: string }) {
  const [copied, setCopied] = useState(false);
  const hydrated = useHydrated();
  const origin = hydrated ? window.location.origin.replace(/\/+$/, "") : "";
  const connectorPath = `/api/mcp/${encodeURIComponent(brainRef)}/mcp`;
  const connectorUrl = origin ? `${origin}${connectorPath}` : connectorPath;

  const copyConnectorUrl = async () => {
    if (!origin) return;
    try {
      await navigator.clipboard.writeText(connectorUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("Could not copy connector URL.");
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-ink/10 p-2.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <span className="block text-[12px] font-medium text-ink">Connect to Claude</span>
          <code className="block truncate text-[12px] leading-5 text-ink-subtle">
            {connectorUrl}
          </code>
        </div>
        <button
          type="button"
          onClick={copyConnectorUrl}
          disabled={!origin}
          aria-label="Copy Claude connector URL"
          title="Copy Claude connector URL"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          {copied ? <Check size={15} strokeWidth={2} /> : <Copy size={15} strokeWidth={2} />}
        </button>
      </div>
      <p className="text-[11.5px] leading-4 text-ink-subtle">
        Claude -&gt; Settings -&gt; Connectors -&gt; Add custom connector, then sign in with your
        Goat account.
      </p>
    </div>
  );
}

function BrainSourcesSection({ brainRef }: { brainRef: string }) {
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

function SourceProviderCard({
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
  const source = details?.sources.find((entry) => entry.provider === provider.id) ?? null;

  const jamie = provider.id === "jamie" ? details?.jamie : undefined;
  const slack = provider.id === "slack" ? details?.slack : undefined;
  const connected =
    provider.id === "jamie"
      ? Boolean(jamie?.integration.connected)
      : provider.id === "slack"
        ? Boolean(slack?.integration.connected)
        : false;
  // Before any per-brain rows exist, Jamie deliveries follow legacy routing to
  // the user's default brain — surface that as an implicit "on" there.
  const legacyEnabled = Boolean(
    provider.id === "jamie" && !source && jamie?.legacyDefaultDelivery && jamie?.isDefaultBrain,
  );
  const enabled = source ? source.enabled : legacyEnabled;
  const canToggle =
    provider.available && (source ? source.isOwnIntegration : connected) && !isPending;

  const toggle = () => {
    const integrationId =
      source?.integrationId ?? jamie?.integration.integrationId ?? slack?.integration.integrationId;
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
            {source && source.integrationStatus !== "connected" ? (
              <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em] text-ink-subtle">
                {source.integrationStatus === "needs_reauth" ? "Needs setup" : "Sync issue"}
              </span>
            ) : null}
          </div>
          <p className="truncate text-[11.5px] leading-4 text-ink-subtle">{provider.description}</p>
        </div>
        {provider.available ? (
          connected || source ? (
            <SourceToggle enabled={enabled} disabled={!canToggle} onToggle={toggle} />
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

function selectionFromSaved(saved: SlackConfigSelection) {
  const map = new Map<string, { name: string; kind: "channel" | "dm" }>();
  for (const channel of saved.channels)
    map.set(channel.id, { name: channel.name, kind: "channel" });
  for (const dm of saved.dms) map.set(dm.id, { name: dm.name, kind: "dm" });
  return map;
}

function SourceToggle({
  enabled,
  disabled,
  onToggle,
}: {
  enabled: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
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
