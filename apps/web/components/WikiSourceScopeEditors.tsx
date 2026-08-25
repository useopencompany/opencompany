"use client";

import type { WikiSourceDto } from "@opencompany/protocol";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  listSlackConversationsAction,
  type SlackConversationListResult,
} from "@/lib/brain-source-actions";

type WikiSourceScopeEditorProps = {
  integrationId: string;
  source: WikiSourceDto | null;
  onSave: (config: Record<string, unknown>) => Promise<boolean>;
};

type SlackConfigSelection = {
  channels: { id: string; name: string }[];
  dms: { id: string; name: string }[];
};

type SlackPickerOption = {
  id: string;
  name: string;
  kind: "channel" | "dm";
  isPrivate?: boolean;
};

function slackSelectionFromConfig(
  config: Record<string, unknown> | undefined,
): SlackConfigSelection {
  const parse = (value: unknown) =>
    Array.isArray(value)
      ? value.flatMap((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
          const record = entry as Record<string, unknown>;
          if (typeof record.id !== "string" || !record.id.trim()) return [];
          return [
            {
              id: record.id.trim(),
              name:
                typeof record.name === "string" && record.name.trim()
                  ? record.name.trim()
                  : record.id.trim(),
            },
          ];
        })
      : [];
  return { channels: parse(config?.channels), dms: parse(config?.dms) };
}

function selectionFromSaved(saved: SlackConfigSelection) {
  return new Map<string, { name: string; kind: "channel" | "dm" }>([
    ...saved.channels.map(
      (channel) => [channel.id, { name: channel.name, kind: "channel" }] as const,
    ),
    ...saved.dms.map((dm) => [dm.id, { name: dm.name, kind: "dm" }] as const),
  ]);
}

export function WikiSlackChannelPicker({
  integrationId,
  source,
  onSave,
}: WikiSourceScopeEditorProps) {
  const saved = useMemo(() => slackSelectionFromConfig(source?.config), [source?.config]);
  const [expanded, setExpanded] = useState(false);
  const [conversations, setConversations] = useState<SlackConversationListResult | null>(null);
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
    void listSlackConversationsAction(integrationId).then((result) => {
      if (!cancelled) setConversations(result);
    });
    return () => {
      cancelled = true;
    };
  }, [conversations, expanded, integrationId]);

  const toggleConversation = (id: string, name: string, kind: "channel" | "dm") => {
    setDirty(true);
    setSelection((current) => {
      const next = new Map(current);
      if (next.has(id)) next.delete(id);
      else next.set(id, { name, kind });
      return next;
    });
  };

  const toggleConversationGroup = (options: SlackPickerOption[]) => {
    if (options.length === 0) return;
    setDirty(true);
    setSelection((current) => {
      const next = new Map(current);
      const allSelected = options.every((option) => current.has(option.id));
      for (const option of options) {
        if (allSelected) next.delete(option.id);
        else next.set(option.id, { name: option.name, kind: option.kind });
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
      if (await onSave({ channels, dms })) setDirty(false);
    });
  };

  const selectedCount = selection.size;
  const summary =
    selectedCount === 0
      ? "No conversations selected yet — nothing is ingested until you choose some."
      : `${selectedCount} conversation${selectedCount === 1 ? "" : "s"} selected.`;

  if (!expanded) {
    return (
      <div className="flex items-center justify-between gap-2 border-t border-border/70 pt-2">
        <p className="text-[11.5px] leading-4 text-ink-subtle">{summary}</p>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="shrink-0 rounded-md border border-ink/15 px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-surface-hover"
        >
          Choose conversations
        </button>
      </div>
    );
  }

  const query = search.trim().toLowerCase();
  const loadedChannels = conversations?.ok ? conversations.channels : [];
  const loadedDms = conversations?.ok ? conversations.dms : [];
  const matchesSearch = (option: { name: string }) =>
    !query || option.name.toLowerCase().includes(query);
  const channelOptions: SlackPickerOption[] = loadedChannels
    .filter((channel) => !channel.isSlackConnect && matchesSearch(channel))
    .map((channel) => ({ ...channel, kind: "channel" }));
  const slackConnectOptions: SlackPickerOption[] = [
    ...loadedChannels
      .filter((channel) => channel.isSlackConnect && matchesSearch(channel))
      .map((channel) => ({ ...channel, kind: "channel" as const })),
    ...loadedDms
      .filter((dm) => dm.isSlackConnect && matchesSearch(dm))
      .map((dm) => ({ ...dm, kind: "dm" as const })),
  ];
  const dmOptions: SlackPickerOption[] = loadedDms
    .filter((dm) => !dm.isSlackConnect && matchesSearch(dm))
    .map((dm) => ({ ...dm, kind: "dm" }));
  const hasSlackConnectConversations =
    loadedChannels.some((channel) => channel.isSlackConnect) ||
    loadedDms.some((dm) => dm.isSlackConnect);
  const bulkActionLabel = (options: SlackPickerOption[]) => {
    const allSelected = options.length > 0 && options.every((option) => selection.has(option.id));
    if (query) return allSelected ? "Clear matches" : "Select matches";
    return allSelected ? "Clear" : "Select all";
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border/70 pt-2">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            strokeWidth={2}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-subtle"
          />
          <input
            type="search"
            aria-label="Search Slack conversations"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search conversations"
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
          <PickerSectionLabel
            label="Channels"
            options={channelOptions}
            actionLabel={bulkActionLabel(channelOptions)}
            onToggle={() => toggleConversationGroup(channelOptions)}
          />
          <div className="flex max-h-[220px] flex-col gap-px overflow-y-auto rounded-md border border-ink/10 p-1">
            {channelOptions.length === 0 ? (
              <div className="px-2 py-1.5 text-[12px] text-ink-subtle">No channels found.</div>
            ) : (
              channelOptions.map((channel) => (
                <SlackOption
                  key={channel.id}
                  option={channel}
                  checked={selection.has(channel.id)}
                  label={`#${channel.name}`}
                  {...(channel.isPrivate ? { detail: "private" } : {})}
                  onToggle={toggleConversation}
                />
              ))
            )}
          </div>
          {hasSlackConnectConversations ? (
            <div className="rounded-md border border-ink/10 p-2">
              <PickerSectionLabel
                label="Slack Connect"
                options={slackConnectOptions}
                actionLabel={bulkActionLabel(slackConnectOptions)}
                onToggle={() => toggleConversationGroup(slackConnectOptions)}
              />
              <p className="mt-0.5 text-[11.5px] leading-4 text-ink-subtle">
                These conversations include people outside your Slack workspace. Selected messages
                become visible to everyone with access to this Wiki.
              </p>
              <div className="mt-1 flex max-h-[180px] flex-col gap-px overflow-y-auto">
                {slackConnectOptions.length === 0 ? (
                  <div className="px-1 py-1 text-[12px] text-ink-subtle">
                    No matching Slack Connect conversations.
                  </div>
                ) : (
                  slackConnectOptions.map((conversation) => (
                    <SlackOption
                      key={conversation.id}
                      option={conversation}
                      checked={selection.has(conversation.id)}
                      label={`${conversation.kind === "channel" ? "#" : ""}${conversation.name}`}
                      detail={
                        conversation.kind === "dm"
                          ? "DM"
                          : conversation.isPrivate
                            ? "private channel"
                            : "channel"
                      }
                      onToggle={toggleConversation}
                    />
                  ))
                )}
              </div>
            </div>
          ) : null}
          <div className="rounded-md border border-ink/10">
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => setDmsOpen((open) => !open)}
                aria-expanded={dmsOpen}
                className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-hover"
              >
                {dmsOpen ? (
                  <ChevronDown size={13} strokeWidth={2} />
                ) : (
                  <ChevronRight size={13} strokeWidth={2} />
                )}
                Direct messages
              </button>
              {dmsOpen && dmOptions.length > 0 ? (
                <button
                  type="button"
                  onClick={() => toggleConversationGroup(dmOptions)}
                  aria-label={`${bulkActionLabel(dmOptions)} direct messages`}
                  className="mr-1 shrink-0 rounded px-1.5 py-0.5 text-[11.5px] font-medium text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
                >
                  {bulkActionLabel(dmOptions)}
                </button>
              ) : null}
            </div>
            {dmsOpen ? (
              <div className="flex flex-col gap-1 px-2 pb-2">
                <p className="text-[11.5px] leading-4 text-ink-subtle">
                  Selected DMs become visible to everyone with access to this Wiki.
                </p>
                <div className="flex max-h-[180px] flex-col gap-px overflow-y-auto">
                  {dmOptions.length === 0 ? (
                    <div className="px-1 py-1 text-[12px] text-ink-subtle">No DMs found.</div>
                  ) : (
                    dmOptions.map((dm) => (
                      <SlackOption
                        key={dm.id}
                        option={dm}
                        checked={selection.has(dm.id)}
                        label={dm.name}
                        onToggle={toggleConversation}
                      />
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
            {isPending ? "Saving…" : "Save conversations"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PickerSectionLabel({
  label,
  options,
  actionLabel,
  onToggle,
}: {
  label: string;
  options: SlackPickerOption[];
  actionLabel: string;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-1">
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
        {label}
      </span>
      {options.length > 0 ? (
        <button
          type="button"
          onClick={onToggle}
          aria-label={`${actionLabel} ${label}`}
          className="rounded px-1.5 py-0.5 text-[11.5px] font-medium text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function SlackOption({
  option,
  checked,
  label,
  detail,
  onToggle,
}: {
  option: SlackPickerOption;
  checked: boolean;
  label: string;
  detail?: string;
  onToggle: (id: string, name: string, kind: "channel" | "dm") => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover">
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(option.id, option.name, option.kind)}
        className="accent-ink"
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail ? <span className="shrink-0 text-[11px] text-ink-subtle">{detail}</span> : null}
    </label>
  );
}

type GmailEventSelection = "email_received" | "email_sent";

const GMAIL_EVENT_OPTIONS: Array<{ id: GmailEventSelection; label: string }> = [
  { id: "email_received", label: "Email received" },
  { id: "email_sent", label: "Email sent" },
];

const GMAIL_INSTRUCTIONS_MAX_LENGTH = 2000;
const GMAIL_DEFAULT_INSTRUCTIONS =
  "Ignore transactional emails, spam, and personal emails. Only ingest emails that directly relate to our company.";

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
    if (typeof id === "string" && allowed.has(id as GmailEventSelection)) {
      seen.add(id as GmailEventSelection);
    }
  }
  return [...seen];
}

function gmailInstructionsFromConfig(config: Record<string, unknown> | undefined) {
  return typeof config?.instructions === "string" ? config.instructions : "";
}

export function WikiGmailSourceEditor({
  integrationId,
  source,
  onSave,
}: WikiSourceScopeEditorProps) {
  const savedEvents = useMemo(() => gmailEventsFromConfig(source?.config), [source?.config]);
  const savedInstructions = useMemo(
    () => gmailInstructionsFromConfig(source?.config),
    [source?.config],
  );
  const isNewSource = !source;
  const [expanded, setExpanded] = useState(false);
  const [eventSelection, setEventSelection] = useState<Set<GmailEventSelection>>(
    () => new Set(savedEvents),
  );
  const [instructions, setInstructions] = useState(
    isNewSource ? GMAIL_DEFAULT_INSTRUCTIONS : savedInstructions,
  );
  const [dirty, setDirty] = useState(isNewSource);
  const [isPending, startTransition] = useTransition();

  const toggleEvent = (eventId: GmailEventSelection) => {
    setDirty(true);
    setEventSelection((current) => {
      const next = new Set(current);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  const save = () => {
    startTransition(async () => {
      const saved = await onSave({
        events: [...eventSelection].map((id) => ({ id })),
        instructions,
      });
      if (saved) setDirty(false);
    });
  };

  const selectedLabels = GMAIL_EVENT_OPTIONS.filter((option) => eventSelection.has(option.id)).map(
    (option) => option.label.toLowerCase(),
  );
  const summary =
    selectedLabels.length === 0
      ? "No email events selected yet — nothing is ingested until you choose some."
      : `Ingesting ${selectedLabels.join(" and ")}${
          instructions.trim() ? ", tuned by your instructions" : ""
        }.`;

  if (!expanded) {
    return (
      <div className="flex items-center justify-between gap-2 border-t border-border/70 pt-2">
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
    <div className="flex flex-col gap-2 border-t border-border/70 pt-2">
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
          htmlFor={`wiki-gmail-instructions-${integrationId}`}
          className="px-1 text-[12px] font-medium text-ink"
        >
          Ingestion instructions (optional)
        </label>
        <textarea
          id={`wiki-gmail-instructions-${integrationId}`}
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
          Tell the librarian what matters in your inbox. It reads selected email events and uses
          these instructions during cheap triage and full ingestion.
        </p>
      </div>
      <p className="text-[11.5px] leading-4 text-ink-subtle">
        Ingested email content — including what other people write to you — becomes visible to
        everyone with access to this Wiki.
      </p>
      {dirty ? (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={isPending}
            onClick={save}
            className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-60"
          >
            {isPending ? "Saving…" : "Save Gmail source"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
