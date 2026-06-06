"use client";

import { ArrowUp, ArrowUpRight, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ToastProvider";

// PROTOTYPE — one-at-a-time triage deck for a founder running an agent army.
//
// Instead of a scrolling list, the inbox is a stack: you see a single card at a time and
// clear it (confirm an action, reply, or snooze). Acting flies the top card away and slides
// the next one forward — inbox-zero for your agents. Each card's artifact is whatever the
// owning agent attached: a quick FYI, model-generated actions, or an inline reply box when it
// needs open-ended steering. The expandable summary shows the agent's steps before you act.

type InboxArtifact =
  | { kind: "fyi"; body: string }
  | { kind: "actions"; note?: string; actions: InboxAction[] }
  | { kind: "reply"; note?: string; placeholder: string; suggestions?: string[] };

type InboxAction = {
  id: string;
  label: string;
  tone?: "primary" | "default" | "danger";
  // The toast shown after taking it — stands in for the real follow-up the agent would run.
  result: string;
};

type InboxCard = {
  id: string;
  agentName: string;
  accent: string;
  title: string;
  timeLabel: string;
  // The expandable "what happened" — the agent's steps leading to this card.
  steps: string[];
  artifact: InboxArtifact;
};

// Direction the top card flies when it leaves, so confirm / snooze / dismiss read differently.
type ExitDir = "confirm" | "snooze" | "dismiss";

// Seed data. Each card is a distinct JTBD a founder hits with many agents in flight.
const SEED_CARDS: InboxCard[] = [
  {
    // JTBD: unblock a gated action without context-switching into the session.
    id: "deploy-approval",
    agentName: "Ops",
    accent: "#3b5bdb",
    title: "Ready to ship v0.9.1 to production",
    timeLabel: "2m ago",
    steps: [
      "Merged 14 commits since v0.9.0",
      "Ran the full suite — 312 passed, 0 failed",
      "Built and staged the release on preview",
      "Holding for your approval to promote to production",
    ],
    artifact: {
      kind: "actions",
      note: "All checks green · 14 commits since last release · waiting on you",
      actions: [
        { id: "deploy", label: "Approve & deploy", tone: "primary", result: "Deploying v0.9.1 to production…" },
        { id: "diff", label: "Review diff", result: "Opening the release diff…" },
      ],
    },
  },
  {
    // JTBD: a real risk surfaced by an agent that needs a fast call, not a read-through.
    id: "billing-incident",
    agentName: "Billing",
    accent: "#e8590c",
    title: "Stripe webhooks failing since 2:04 PM — 4 payments stuck",
    timeLabel: "8m ago",
    steps: [
      "Detected 4 failed webhook deliveries at 2:04 PM",
      "Traced the cause to this morning's endpoint secret rotation",
      "Confirmed all 4 payments did succeed in Stripe",
      "Replays are idempotent — safe to run",
    ],
    artifact: {
      kind: "actions",
      note: "Signature mismatch after the endpoint rotation. Replaying is safe.",
      actions: [
        { id: "replay", label: "Replay 4 events", tone: "primary", result: "Replaying 4 webhook events…" },
        { id: "investigate", label: "Investigate", result: "Billing is digging into the signature mismatch…" },
      ],
    },
  },
  {
    // JTBD: open-ended steering — the agent wants direction, not a fixed choice. Reply inline.
    id: "launch-copy",
    agentName: "Content",
    accent: "#1c7ed6",
    title: "Drafting the v0.9.1 launch post — how should it land?",
    timeLabel: "12m ago",
    steps: [
      "Pulled the v0.9.1 changelog highlights",
      "Sketched three possible angles",
      "Needs your steer before writing the options out",
    ],
    artifact: {
      kind: "reply",
      note: "Tell me the angle and I'll come back with three drafts.",
      placeholder: "e.g. lead with the time saved, keep it founder-voice…",
      suggestions: ["Keep it short", "Lead with the demo", "Founder voice"],
    },
  },
  {
    // JTBD: approve work-product the agent produced (drafts) in one move.
    id: "recruiting-drafts",
    agentName: "Recruiting",
    accent: "#0c8599",
    title: "2 candidate outreach emails drafted and ready",
    timeLabel: "26m ago",
    steps: [
      "Sourced 2 candidates for the staff eng + founding designer roles",
      "Reviewed their recent public work",
      "Wrote a personalized first-touch for each",
    ],
    artifact: {
      kind: "actions",
      note: "Staff eng + founding designer · personalized from their recent work",
      actions: [
        { id: "send", label: "Send both", tone: "primary", result: "Sent. Recruiting will log replies here." },
        { id: "open", label: "Read drafts", result: "Opening the drafts…" },
      ],
    },
  },
  {
    // JTBD: a budget/limit guardrail that wants a decision before it pauses or overspends.
    id: "budget-cap",
    agentName: "Growth",
    accent: "#7048e8",
    title: "Growth agent is at 84% of its $50 weekly budget",
    timeLabel: "1h ago",
    steps: [
      "Spent $42 of the $50 weekly cap",
      "Running 3 LinkedIn ad experiments",
      "On pace to hit the cap Thursday and auto-pause",
    ],
    artifact: {
      kind: "actions",
      note: "On pace to hit the cap by Thursday and pause itself.",
      actions: [
        { id: "raise", label: "Raise to $100", tone: "primary", result: "Weekly cap raised to $100." },
        { id: "pause", label: "Let it pause", tone: "danger", result: "Growth will pause when it hits $50." },
      ],
    },
  },
  {
    // JTBD: a pure FYI — completed work you should know landed, no action required.
    id: "research-summary",
    agentName: "Research",
    accent: "#2f9e44",
    title: "Competitive teardown ready: Linear, Height, Cycle",
    timeLabel: "3h ago",
    steps: [
      "Compared Linear, Height, and Cycle",
      "Mapped positioning gaps and pricing tiers",
      "Filed a 3-page summary in Research",
    ],
    artifact: {
      kind: "fyi",
      body: "Three-page summary with positioning gaps and a pricing comparison. Nothing needs your input — it's filed in Research for when you want it.",
    },
  },
];

const EXIT_MS = 300;

function ActionButton({ action, onTake }: { action: InboxAction; onTake: (action: InboxAction) => void }) {
  const base =
    "rounded-md px-2.5 py-1.5 text-[12.5px] font-medium tracking-[-0.005em] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20";
  const tone =
    action.tone === "primary"
      ? "bg-ink text-canvas hover:bg-ink/85"
      : action.tone === "danger"
        ? "border border-border bg-surface text-danger hover:bg-surface-hover"
        : "border border-border bg-surface text-ink/85 hover:bg-surface-hover hover:text-ink";
  return (
    <button type="button" onClick={() => onTake(action)} className={`${base} ${tone}`}>
      {action.label}
    </button>
  );
}

// Inline reply composer for cards that need open-ended steering. Enter sends; suggestion
// chips are one-tap shortcuts that send immediately.
function ReplyArtifact({
  artifact,
  onSend,
}: {
  artifact: Extract<InboxArtifact, { kind: "reply" }>;
  onSend: (text: string) => void;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue("");
  };
  return (
    <div className="flex flex-col gap-2">
      {artifact.note ? <p className="text-[12px] leading-4 text-ink-muted">{artifact.note}</p> : null}
      {artifact.suggestions?.length ? (
        <div className="flex flex-wrap gap-1.5">
          {artifact.suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => onSend(suggestion)}
              className="rounded-full border border-border bg-surface px-2.5 py-1 text-[12px] text-ink/80 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex items-end gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 transition-colors duration-150 focus-within:border-border-strong">
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder={artifact.placeholder}
          className="min-h-6 w-full resize-none bg-transparent text-[12.5px] leading-5 text-ink placeholder:text-ink-subtle outline-none"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!value.trim()}
          aria-label="Send reply"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-canvas transition-colors duration-150 hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <ArrowUp size={12} strokeWidth={2.25} />
        </button>
      </div>
    </div>
  );
}

// The full card face. Only the front card is interactive; the flying-away copy renders the
// same face with interactivity off.
function CardFace({
  card,
  interactive,
  onOpen,
  onTake,
  onReply,
  onSnooze,
  onAck,
}: {
  card: InboxCard;
  interactive: boolean;
  onOpen: () => void;
  onTake: (action: InboxAction) => void;
  onReply: (text: string) => void;
  onSnooze: () => void;
  onAck: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3.5 shadow-[0_1px_3px_rgba(15,15,15,0.05)]">
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden
          className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: card.accent }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpen}
              className="min-w-0 flex-1 truncate text-left text-[14px] font-medium tracking-[-0.005em] text-ink hover:underline"
            >
              {card.title}
            </button>
            <span className="shrink-0 text-[11px] tabular-nums text-ink-subtle">{card.timeLabel}</span>
          </div>

          {/* Reference + disclosure. Agent name links into the live session; the toggle
              reveals what the agent did to get here. */}
          <div className="mt-1 flex items-center gap-2 text-[11.5px] text-ink-subtle">
            <button
              type="button"
              onClick={onOpen}
              title={`Open ${card.agentName} session`}
              className="group/ref inline-flex items-center gap-0.5 text-ink-muted transition-colors duration-150 hover:text-ink"
            >
              {card.agentName}
              <ArrowUpRight
                size={11}
                strokeWidth={2}
                className="opacity-0 transition-opacity duration-150 group-hover/ref:opacity-100"
              />
            </button>
            <span aria-hidden>·</span>
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
          </div>

          {expanded ? (
            <ol className="mt-2 flex flex-col gap-1 border-l border-border pl-3">
              {card.steps.map((step, index) => (
                <li key={step} className="flex gap-2 text-[12px] leading-5 text-ink-muted">
                  <span className="shrink-0 tabular-nums text-ink-subtle">{index + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          ) : null}

          {/* Artifact note / body / reply box, then a single controls row where the confirm
              buttons and Snooze share the same baseline (Snooze pushed to the right). */}
          <div className="mt-3 flex flex-col gap-2.5">
            {card.artifact.kind === "fyi" ? (
              <p className="text-[12.5px] leading-5 text-ink-muted">{card.artifact.body}</p>
            ) : card.artifact.kind === "reply" ? (
              <ReplyArtifact artifact={card.artifact} onSend={onReply} />
            ) : card.artifact.note ? (
              <p className="text-[12px] leading-4 text-ink-muted">{card.artifact.note}</p>
            ) : null}

            <div className="flex flex-wrap items-center gap-1.5">
              {card.artifact.kind === "actions"
                ? card.artifact.actions.map((action) => (
                    <ActionButton key={action.id} action={action} onTake={onTake} />
                  ))
                : null}
              {card.artifact.kind === "fyi" ? (
                <button
                  type="button"
                  onClick={onAck}
                  className="rounded-md bg-ink px-2.5 py-1.5 text-[12.5px] font-medium tracking-[-0.005em] text-canvas transition-colors duration-150 hover:bg-ink/85"
                >
                  Got it
                </button>
              ) : null}
              <button
                type="button"
                onClick={onSnooze}
                tabIndex={interactive ? 0 : -1}
                className="ml-auto rounded-md px-2.5 py-1.5 text-[12.5px] font-medium tracking-[-0.005em] text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                Snooze
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PersonalInbox({
  userName,
  sessionIds,
  onOpenSession,
}: {
  userName: string;
  // Real session ids to wire the reference links onto, keyed by the card's seed order.
  sessionIds: string[];
  onOpenSession: (sessionId: string) => void;
}) {
  const { showToast } = useToast();
  // The live deck. Snoozing reorders to the back; confirming/dismissing removes.
  const [queue, setQueue] = useState<InboxCard[]>(() => SEED_CARDS);
  const [exiting, setExiting] = useState<{ id: string; dir: ExitDir } | null>(null);
  const [play, setPlay] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Drive the exit: first paint the leaving card in place, then on the next frame flip to the
  // exit transform so it transitions, then commit the queue mutation when the motion ends.
  useEffect(() => {
    if (!exiting) return;
    const raf = requestAnimationFrame(() => setPlay(true));
    timerRef.current = setTimeout(() => {
      setQueue((prev) => {
        const index = prev.findIndex((card) => card.id === exiting.id);
        if (index === -1) return prev;
        const next = prev.slice();
        const [card] = next.splice(index, 1);
        if (card && exiting.dir === "snooze") next.push(card);
        return next;
      });
      setExiting(null);
      setPlay(false);
    }, EXIT_MS);
    return () => {
      cancelAnimationFrame(raf);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [exiting]);

  const firstName = userName.split(" ")[0] || userName;

  const beginExit = (id: string, dir: ExitDir) => {
    if (exiting) return; // ignore input mid-animation
    setExiting({ id, dir });
  };

  const openSession = (card: InboxCard) => {
    const sessionId = sessionIds[SEED_CARDS.findIndex((seed) => seed.id === card.id)];
    if (sessionId) {
      onOpenSession(sessionId);
      return;
    }
    showToast({
      title: "Prototype",
      description: `No linked session yet — this would open ${card.agentName}.`,
      tone: "default",
    });
  };

  const takeAction = (card: InboxCard, action: InboxAction) => {
    showToast({ title: card.agentName, description: action.result, tone: "default" });
    beginExit(card.id, "confirm");
  };

  const replyToCard = (card: InboxCard, text: string) => {
    const trimmed = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    showToast({
      title: card.agentName,
      description: `Sent “${trimmed}” — continuing in the session.`,
      tone: "default",
    });
    beginExit(card.id, "confirm");
  };

  const ackCard = (card: InboxCard) => beginExit(card.id, "confirm");

  const snoozeCard = (card: InboxCard) => {
    showToast({
      title: card.agentName,
      description: "Snoozed — I'll resurface this later.",
      tone: "default",
    });
    beginExit(card.id, "snooze");
  };

  // The deck excludes the flying-away card so the rest can shift forward immediately.
  const deck = exiting ? queue.filter((card) => card.id !== exiting.id) : queue;
  const front = deck[0];
  const behind = deck.slice(1, 3);
  const exitingCard = exiting ? queue.find((card) => card.id === exiting.id) : null;

  const exitTransform = !play
    ? "none"
    : exiting?.dir === "snooze"
      ? "translateY(72px) scale(0.96)"
      : exiting?.dir === "dismiss"
        ? "translateX(-110%) rotate(-2deg)"
        : "translateX(112%) rotate(2deg)";

  const remaining = queue.length;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-baseline justify-between">
        <h1 className="text-[19px] font-semibold tracking-[-0.01em] text-ink">
          Good to see you, {firstName}
        </h1>
        {remaining > 0 ? (
          <span className="text-[12px] text-ink-subtle">{remaining} to clear</span>
        ) : null}
      </div>

      {remaining === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-surface/35 px-4 py-10 text-center text-[13px] text-ink-muted">
          You're all caught up. Start something below.
        </div>
      ) : (
        <div className="relative min-h-[150px]">
          {/* Behind cards — empty chrome offset down to read as a deck. The deepest one stays
              invisible so it can fade in as the front leaves. */}
          {behind.map((card, i) => {
            const depth = i + 1;
            return (
              <div
                key={card.id}
                aria-hidden
                className="absolute inset-0 rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(15,15,15,0.03)]"
                style={{
                  transform: `translateY(${depth * 5}px) scale(${1 - depth * 0.03})`,
                  transformOrigin: "bottom center",
                  zIndex: 30 - depth,
                  opacity: depth >= 2 ? 0.6 : 1,
                  transition: "transform 260ms cubic-bezier(0.4,0,0.2,1), opacity 220ms ease",
                }}
              />
            );
          })}

          {/* The flying-away card. */}
          {exitingCard ? (
            <div
              className="pointer-events-none absolute inset-0 z-50"
              style={{
                transform: exitTransform,
                opacity: play ? 0 : 1,
                transition: `transform ${EXIT_MS}ms cubic-bezier(0.4,0,0.2,1), opacity ${EXIT_MS - 40}ms ease`,
              }}
            >
              <CardFace
                card={exitingCard}
                interactive={false}
                onOpen={() => {}}
                onTake={() => {}}
                onReply={() => {}}
                onSnooze={() => {}}
                onAck={() => {}}
              />
            </div>
          ) : null}

          {/* The front card defines the stack height and is the only interactive face. Keyed
              by id so it re-mounts and runs a small enter animation as the next one arrives. */}
          {front ? (
            <div key={front.id} className="relative z-40 animate-[inboxIn_220ms_ease-out]">
              <CardFace
                card={front}
                interactive
                onOpen={() => openSession(front)}
                onTake={(action) => takeAction(front, action)}
                onReply={(text) => replyToCard(front, text)}
                onSnooze={() => snoozeCard(front)}
                onAck={() => ackCard(front)}
              />
            </div>
          ) : (
            <div className="h-[150px]" aria-hidden />
          )}
        </div>
      )}

      <style>{`@keyframes inboxIn{from{opacity:0;transform:translateY(8px) scale(0.985)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}
