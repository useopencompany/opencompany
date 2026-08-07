"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { MessageSquare, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import {
  getBrainSlackBotDestinationAction,
  listSlackBotChannelsAction,
  type SlackBotChannel,
  type SlackBotChannelListResult,
  type SlackBotDestinationView,
  setBrainSlackBotDestinationAction,
} from "@/lib/slack-bot-actions";

// The Slack bot as an answer destination: which channels this brain answers
// @opencompany mentions in. Deliberately separate from the Sources card grid —
// this is where the brain talks, not where it listens.
export function SlackBotDestinationCard({ brainRef }: { brainRef: string }) {
  const [view, setView] = useState<SlackBotDestinationView | null | undefined>(undefined);
  const [isPending, startTransition] = useTransition();

  const reload = async () => {
    const result = await getBrainSlackBotDestinationAction(brainRef);
    setView(result);
  };

  useEffect(() => {
    let cancelled = false;
    void getBrainSlackBotDestinationAction(brainRef).then((result) => {
      if (!cancelled) setView(result);
    });
    return () => {
      cancelled = true;
    };
  }, [brainRef]);

  if (view === undefined) {
    return (
      <div className="rounded-lg border border-ink/10 p-3 text-[12px] text-ink-subtle">
        Loading…
      </div>
    );
  }
  if (view === null) return null;

  const enabled = view.source?.enabled ?? false;
  const channels = view.source?.channels ?? [];

  const setEnabled = (next: boolean) => {
    startTransition(async () => {
      const result = await setBrainSlackBotDestinationAction({
        brainRef,
        enabled: next,
        channels,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await reload();
    });
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-ink/10 p-3">
      <div className="flex items-center gap-2.5">
        <MessageSquare size={16} strokeWidth={1.75} className="shrink-0 text-ink-subtle" />
        <div className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-medium leading-tight text-ink">Slack bot</span>
          <span className="block text-[12px] leading-4 text-ink-subtle">
            Answer @opencompany mentions in Slack from this brain.
          </span>
        </div>
        {view.installed && view.isAdmin ? (
          <button
            type="button"
            role="switch"
            aria-label={enabled ? "Disable Slack bot destination" : "Enable Slack bot destination"}
            aria-checked={enabled}
            disabled={isPending || !view.botConnected}
            onClick={() => setEnabled(!enabled)}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
              enabled ? "bg-ink" : "bg-ink/20"
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-canvas transition-[left] ${
                enabled ? "left-[18px]" : "left-0.5"
              }`}
            />
          </button>
        ) : null}
      </div>

      {!view.installed ? (
        <p className="border-t border-ink/10 pt-2 text-[12px] leading-4 text-ink-subtle">
          {view.isAdmin ? (
            <>
              Connect the OpenCompany Slack bot in{" "}
              <Link
                href="/settings/workspace/slack"
                prefetch
                className="text-ink underline underline-offset-2"
              >
                workspace settings
              </Link>{" "}
              first.
            </>
          ) : (
            "Ask a workspace admin to connect the OpenCompany Slack bot in workspace settings."
          )}
        </p>
      ) : view.isAdmin && !view.botConnected ? (
        <p className="border-t border-ink/10 pt-2 text-[12px] leading-4 text-warning">
          The Slack bot connection needs attention. Reconnect it in{" "}
          <Link href="/settings/workspace/slack" prefetch className="underline underline-offset-2">
            workspace settings
          </Link>
          .
        </p>
      ) : !view.isAdmin ? (
        <p className="border-t border-ink/10 pt-2 text-[12px] leading-4 text-ink-subtle">
          {enabled
            ? `Enabled in ${channels.length} channel${channels.length === 1 ? "" : "s"}. Managed by workspace admins.`
            : "Not enabled. Managed by workspace admins."}
        </p>
      ) : (
        <>
          <p className="text-[11.5px] leading-4 text-ink-subtle">
            Answers are visible to everyone in the selected Slack channels.
          </p>
          {view.brainVisibility === "restricted" ? (
            <p className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11.5px] leading-4 text-warning">
              This brain has restricted access, but bot answers in Slack are visible to the whole
              channel.
            </p>
          ) : null}
          {enabled ? (
            <SlackBotChannelPicker
              brainRef={brainRef}
              savedChannels={channels}
              onSave={async (nextChannels) => {
                const result = await setBrainSlackBotDestinationAction({
                  brainRef,
                  enabled: true,
                  channels: nextChannels,
                });
                if (!result.ok) {
                  toast.error(result.error);
                  return false;
                }
                toast.success("Slack bot channels updated.");
                await reload();
                return true;
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function SlackBotChannelPicker({
  brainRef,
  savedChannels,
  onSave,
}: {
  brainRef: string;
  savedChannels: Array<{ id: string; name: string }>;
  onSave: (channels: Array<{ id: string; name: string }>) => Promise<boolean>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [available, setAvailable] = useState<SlackBotChannelListResult | null>(null);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<Map<string, string>>(
    () => new Map(savedChannels.map((channel) => [channel.id, channel.name])),
  );
  const [dirty, setDirty] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!expanded || available) return;
    let cancelled = false;
    void listSlackBotChannelsAction(brainRef).then((result) => {
      if (!cancelled) setAvailable(result);
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, available, brainRef]);

  const toggleChannel = (channel: SlackBotChannel) => {
    setDirty(true);
    setSelection((current) => {
      const next = new Map(current);
      if (next.has(channel.id)) {
        next.delete(channel.id);
      } else {
        next.set(channel.id, channel.name);
      }
      return next;
    });
  };

  const save = () => {
    startTransition(async () => {
      const channels = [...selection].map(([id, name]) => ({ id, name }));
      const saved = await onSave(channels);
      if (saved) setDirty(false);
    });
  };

  const summary =
    selection.size === 0
      ? "No channels selected yet — the bot won't answer anywhere."
      : `${selection.size} channel${selection.size === 1 ? "" : "s"} selected.`;

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
  const options = (available?.ok ? available.channels : []).filter(
    (channel) => !query || channel.name.toLowerCase().includes(query),
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
      {available === null ? (
        <div className="px-1 py-1.5 text-[12px] text-ink-subtle">Loading channels…</div>
      ) : !available.ok ? (
        <div className="px-1 py-1.5 text-[12px] text-warning">{available.error}</div>
      ) : (
        <>
          <div className="flex max-h-[220px] flex-col gap-px overflow-y-auto rounded-md border border-ink/10 p-1">
            {options.length === 0 ? (
              <div className="px-2 py-1.5 text-[12px] text-ink-subtle">No channels found.</div>
            ) : (
              options.map((channel) => (
                <label
                  key={channel.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover"
                >
                  <input
                    type="checkbox"
                    checked={selection.has(channel.id)}
                    onChange={() => toggleChannel(channel)}
                    className="accent-ink"
                  />
                  <span className="min-w-0 flex-1 truncate">#{channel.name}</span>
                  {!channel.isMember ? (
                    <span className="shrink-0 text-[11px] text-ink-subtle">
                      invite @opencompany first
                    </span>
                  ) : channel.isPrivate ? (
                    <span className="shrink-0 text-[11px] text-ink-subtle">private</span>
                  ) : null}
                </label>
              ))
            )}
          </div>
          {available.partial ? (
            <p className="text-[11.5px] leading-4 text-ink-subtle">
              Some channels could not be loaded; the list may be incomplete.
            </p>
          ) : null}
          {dirty ? (
            <button
              type="button"
              onClick={save}
              disabled={isPending}
              className="w-fit rounded-md bg-ink px-2.5 py-1 text-[12px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {isPending ? "Saving…" : "Save channels"}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
