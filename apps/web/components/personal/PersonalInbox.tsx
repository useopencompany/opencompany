"use client";

import { useLiveQuery } from "@tanstack/react-db";
import { ArrowUpRight, Check, ChevronRight, Clock, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useCollections } from "@/components/CollectionsProvider";
import { useToast } from "@/components/ToastProvider";
import { useHydrated } from "@/components/useHydrated";
import { deriveVisibleInbox, type InboxItemPayload } from "@/lib/collections/selectors";

// The personal inbox: a live, flat list of attention items the user's agent posted (via the
// inbox_add tool, including from scheduled/background runs). The user triages each: Done resolves
// it, Snooze hides it for 6h (the row stays so the agent still sees it), Dismiss discards it.
// Clicking a card opens the originating agent session. Replaces the earlier hardcoded prototype.

// Re-derive visibility on a slow tick so snoozed items reappear once their window elapses without a
// refresh (snooze is computed client-side; nothing else wakes them).
const VISIBILITY_TICK_MS = 30_000;

const PRIORITY_STYLES: Record<
  NonNullable<InboxItemPayload["priority"]>,
  { label: string; dot: string; text: string }
> = {
  urgent: { label: "Urgent", dot: "var(--color-danger)", text: "text-danger" },
  high: { label: "High", dot: "var(--color-warning)", text: "text-warning" },
  med: { label: "Med", dot: "var(--color-warning)", text: "text-ink/80" },
  low: { label: "Low", dot: "var(--color-ink-subtle)", text: "text-ink-muted" },
};

function PriorityPill({ priority }: { priority: NonNullable<InboxItemPayload["priority"]> }) {
  const s = PRIORITY_STYLES[priority];
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11.5px] font-medium tracking-[-0.005em] ${s.text}`}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.dot }} />
      {s.label}
    </span>
  );
}

function relativeTime(iso: string, now: number): string {
  const diff = now - Date.parse(iso);
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return day === 1 ? "1d ago" : `${day}d ago`;
}

function ActionButton({
  icon: Icon,
  label,
  tone = "default",
  onClick,
}: {
  icon: typeof Check;
  label: string;
  tone?: "default" | "primary";
  onClick: () => void;
}) {
  const base =
    "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-medium tracking-[-0.005em] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/15";
  const variant =
    tone === "primary"
      ? "border border-border-strong bg-surface text-ink hover:bg-surface-muted"
      : "text-ink-muted hover:bg-surface-subtle hover:text-ink";
  return (
    <button type="button" onClick={onClick} className={`${base} ${variant}`}>
      <Icon size={12} strokeWidth={1.85} />
      {label}
    </button>
  );
}

function InboxRow({
  item,
  now,
  onOpenSession,
  onDone,
  onSnooze,
  onDismiss,
}: {
  item: InboxItemPayload;
  now: number;
  onOpenSession: (sessionId: string) => void;
  onDone: () => void;
  onSnooze: () => void;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasSession = Boolean(item.sourceSessionId);

  return (
    <div className="border-b border-border-subtle px-4 py-3 last:border-b-0">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => hasSession && onOpenSession(item.sourceSessionId as string)}
              disabled={!hasSession}
              className={`min-w-0 flex-1 truncate text-left text-[14px] font-medium tracking-[-0.005em] text-ink ${
                hasSession ? "hover:underline" : "cursor-default"
              }`}
            >
              {item.title}
            </button>
            {item.priority ? <PriorityPill priority={item.priority} /> : null}
          </div>

          {/* Source + provenance + the steps disclosure. */}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-subtle">
            {item.source ? <span className="text-ink-muted">{item.source}</span> : null}
            <span className="tabular-nums">{relativeTime(item.createdAt, now)}</span>
            {hasSession ? (
              <button
                type="button"
                onClick={() => onOpenSession(item.sourceSessionId as string)}
                className="group/ref inline-flex items-center gap-0.5 text-ink-muted transition-colors duration-150 hover:text-ink"
              >
                View conversation
                <ArrowUpRight size={11} strokeWidth={2} />
              </button>
            ) : null}
            {item.steps.length > 0 ? (
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                aria-expanded={expanded}
                className="inline-flex items-center gap-0.5 transition-colors duration-150 hover:text-ink"
              >
                <ChevronRight
                  size={12}
                  strokeWidth={2}
                  className={`transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
                />
                {expanded ? "Hide steps" : "What happened"}
              </button>
            ) : null}
          </div>

          {item.body ? (
            <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-5 text-ink-muted">
              {item.body}
            </p>
          ) : null}

          {expanded && item.steps.length > 0 ? (
            <ol className="mt-2 flex flex-col gap-1 border-l border-border pl-3">
              {item.steps.map((step, index) => (
                <li key={step} className="flex gap-2 text-[12px] leading-5 text-ink-muted">
                  <span className="shrink-0 tabular-nums text-ink-subtle">{index + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          ) : null}

          <div className="mt-3 flex items-center gap-1.5">
            <ActionButton icon={Check} label="Done" tone="primary" onClick={onDone} />
            <ActionButton icon={Clock} label="Snooze" onClick={onSnooze} />
            <ActionButton icon={X} label="Dismiss" onClick={onDismiss} />
          </div>
        </div>
      </div>
    </div>
  );
}

function InboxList({ onOpenSession }: { onOpenSession: (sessionId: string) => void }) {
  const { inboxItems } = useCollections();
  const { showToast } = useToast();
  const { data: rows, isLoading } = useLiveQuery((q) => q.from({ item: inboxItems }));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), VISIBILITY_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const items = useMemo(
    () => (isLoading || !rows ? [] : deriveVisibleInbox(rows, now)),
    [rows, isLoading, now],
  );

  const done = (id: string) => {
    inboxItems.update(id, (draft) => {
      draft.status = "done";
    });
    showToast({ title: "Marked done", tone: "default" });
  };
  const snooze = (id: string) => {
    // The server stamps the authoritative snoozed_until (now + 6h); this optimistic value only has
    // to be in the future so deriveVisibleInbox hides the row immediately. Derive it from the
    // ticking `now` state to keep the handler pure (no Date.now() during render).
    const snoozedUntil = new Date(now + 6 * 60 * 60 * 1000).toISOString();
    inboxItems.update(id, (draft) => {
      draft.status = "snoozed";
      draft.snoozed_until = snoozedUntil;
    });
    showToast({ title: "Snoozed for 6 hours", tone: "default" });
  };
  const dismiss = (id: string) => {
    inboxItems.update(id, (draft) => {
      draft.status = "dismissed";
    });
    showToast({ title: "Dismissed", tone: "default" });
  };

  if (isLoading) {
    return <div className="h-[120px]" aria-hidden />;
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface/35 px-4 py-10 text-center text-[13px] text-ink-muted">
        You&apos;re all caught up. Start something below.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
      {items.map((item) => (
        <InboxRow
          key={item.id}
          item={item}
          now={now}
          onOpenSession={onOpenSession}
          onDone={() => done(item.id)}
          onSnooze={() => snooze(item.id)}
          onDismiss={() => dismiss(item.id)}
        />
      ))}
    </div>
  );
}

// Count of visible items, for the greeting line. Mirrors InboxList's derivation but returns only
// the count so the header can show "{n} to clear".
function InboxCount() {
  const { inboxItems } = useCollections();
  const { data: rows, isLoading } = useLiveQuery((q) => q.from({ item: inboxItems }));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), VISIBILITY_TICK_MS);
    return () => clearInterval(id);
  }, []);
  const count = isLoading || !rows ? 0 : deriveVisibleInbox(rows, now).length;
  if (count === 0) return null;
  return <span className="text-[12px] text-ink-subtle">{count} to clear</span>;
}

export function PersonalInbox({
  userName,
  onOpenSession,
}: {
  userName: string;
  onOpenSession: (sessionId: string) => void;
}) {
  // useLiveQuery reads useSyncExternalStore with no server snapshot, so it must only subscribe
  // after hydration (same gate as PersonalSidebar) or the collection's load state sticks.
  const hydrated = useHydrated();
  const firstName = userName.split(" ")[0] || userName;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-baseline justify-between">
        <h1 className="text-[19px] font-semibold tracking-[-0.01em] text-ink">
          Good to see you, {firstName}
        </h1>
        {hydrated ? <InboxCount /> : null}
      </div>
      {hydrated ? (
        <InboxList onOpenSession={onOpenSession} />
      ) : (
        <div className="h-[120px]" aria-hidden />
      )}
    </div>
  );
}
