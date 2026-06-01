import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Circle,
  CircleDot,
  Clock,
  Image as ImageIcon,
  MoreHorizontal,
  Plus,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

type Priority = "urgent" | "high" | "med" | "low";
type Status = "todo" | "in_progress";

type Task = {
  id: string;
  title: string;
  source: string;
  project: string;
  status: Status;
  priority: Priority;
  due: string;
};

const tasks: Task[] = [
  {
    id: "INB-104",
    title: "Review Acme renewal proposal before Friday call",
    source: "Gmail",
    project: "Revenue",
    status: "todo",
    priority: "urgent",
    due: "Today",
  },
  {
    id: "INB-103",
    title: "Approve Q3 hiring plan for the platform team",
    source: "Notion",
    project: "People",
    status: "in_progress",
    priority: "high",
    due: "Tomorrow",
  },
  {
    id: "INB-102",
    title: "Sign off on landing page copy revisions",
    source: "Linear",
    project: "Marketing",
    status: "todo",
    priority: "med",
    due: "Wed",
  },
  {
    id: "INB-101",
    title: "Draft response to investor update questions",
    source: "Slack",
    project: "Fundraising",
    status: "todo",
    priority: "low",
    due: "Fri",
  },
];

function ChatBox() {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 pt-3.5 pb-2.5 shadow-[0_1px_2px_rgba(15,15,15,0.03),0_0_0_1px_rgba(15,15,15,0.01)] transition-shadow duration-200 focus-within:border-border-strong focus-within:shadow-[0_1px_2px_rgba(15,15,15,0.04),0_0_0_3px_rgba(15,15,15,0.04)]">
      <input
        type="text"
        placeholder="Ask, triage, or delegate from your inbox"
        className="w-full bg-transparent text-[14px] leading-6 tracking-[-0.005em] text-ink placeholder:text-ink-subtle outline-none"
      />
      <div className="mt-6 flex items-center gap-2">
        <button className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12.5px] text-ink/90 transition-colors duration-150 hover:bg-surface-hover hover:text-ink">
          <span>GPT-5.5 High</span>
          <ChevronDown size={12} strokeWidth={1.75} className="text-ink-muted" />
        </button>

        <div className="flex items-center">
          <span className="relative inline-flex h-5 w-5 items-center justify-center rounded-full border border-surface bg-ink text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.12)]">
            <Plus size={11} strokeWidth={2.25} />
          </span>
          <span
            aria-hidden
            className="-ml-1.5 h-5 w-5 rounded-full border border-surface shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
            style={{
              background:
                "radial-gradient(circle at 35% 30%, #ffffff 0%, #d0d0cf 30%, #1a1a1a 80%)",
            }}
          />
          <button className="ml-1 rounded p-0.5 text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink">
            <ChevronDown size={12} strokeWidth={1.75} />
          </button>
        </div>

        <button className="ml-1 flex items-center gap-1.5 rounded-full bg-surface-selected px-2.5 py-1 text-[12px] font-medium text-ink/85 ring-1 ring-inset ring-border transition-colors duration-150 hover:bg-surface-active">
          <Sparkles size={11} strokeWidth={2} />
          <span>Triage inbox</span>
        </button>

        <div className="ml-auto flex items-center gap-1">
          <button className="rounded-md p-1.5 text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink">
            <ImageIcon size={14} strokeWidth={1.75} />
          </button>
          <button className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85">
            <ArrowUp size={13} strokeWidth={2.25} />
          </button>
        </div>
      </div>
    </div>
  );
}

const priorityStyles: Record<Priority, { label: string; dot: string; text: string }> = {
  urgent: { label: "Urgent", dot: "var(--color-danger)", text: "text-danger" },
  high: { label: "High", dot: "var(--color-warning)", text: "text-warning" },
  med: { label: "Med", dot: "var(--color-warning)", text: "text-ink/80" },
  low: { label: "Low", dot: "var(--color-ink-subtle)", text: "text-ink-muted" },
};

function PriorityPill({ priority }: { priority: Priority }) {
  const s = priorityStyles[priority];
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11.5px] font-medium tracking-[-0.005em] ${s.text}`}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.dot }} />
      {s.label}
    </span>
  );
}

function StatusGlyph({ status }: { status: Status }) {
  if (status === "in_progress") {
    return <CircleDot size={14} strokeWidth={1.75} className="text-warning" />;
  }
  return <Circle size={14} strokeWidth={1.75} className="text-ink/40" />;
}

function ActionButton({
  icon: Icon,
  label,
  tone = "default",
}: {
  icon: LucideIcon;
  label: string;
  tone?: "default" | "primary";
}) {
  const base =
    "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-medium tracking-[-0.005em] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/15";
  const variant =
    tone === "primary"
      ? "border border-border-strong bg-surface text-ink hover:bg-surface-muted"
      : "text-ink-muted hover:bg-surface-subtle hover:text-ink";
  return (
    <button className={`${base} ${variant}`}>
      <Icon size={12} strokeWidth={1.85} />
      {label}
    </button>
  );
}

function TaskRow({ task }: { task: Task }) {
  return (
    <div className="group relative flex items-center gap-3 border-b border-border-subtle px-3 py-2 last:border-b-0 hover:bg-surface-muted">
      <button
        aria-label="Toggle status"
        className="flex shrink-0 items-center justify-center rounded-sm p-0.5 hover:bg-surface-subtle"
      >
        <StatusGlyph status={task.status} />
      </button>

      <span className="shrink-0 text-[11.5px] font-medium tabular-nums text-ink-subtle">
        {task.id}
      </span>

      <span className="min-w-0 flex-1 truncate text-[13px] tracking-[-0.005em] text-ink">
        {task.title}
      </span>

      <div className="hidden shrink-0 items-center gap-3 text-[11.5px] text-ink-muted transition-opacity duration-150 group-hover:opacity-0 md:flex">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-ink-subtle/45" />
          {task.project}
        </span>
        <span className="text-ink-subtle">{task.source}</span>
        <PriorityPill priority={task.priority} />
        <span className="w-10 text-right tabular-nums text-ink-muted">{task.due}</span>
      </div>

      <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-1 pl-6 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100">
        <div
          aria-hidden
          className="absolute inset-y-0 -left-8 right-0 bg-gradient-to-l from-surface-muted via-surface-muted to-transparent"
        />
        <div className="relative flex items-center gap-1">
          <ActionButton icon={Check} label="Done" tone="primary" />
          <ActionButton icon={Clock} label="Snooze" />
          <ActionButton icon={Bot} label="Delegate" />
          <button
            aria-label="More"
            className="ml-0.5 rounded-md p-1 text-ink-muted transition-colors duration-150 hover:bg-surface-subtle hover:text-ink"
          >
            <MoreHorizontal size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </div>
  );
}

function TaskList() {
  return (
    <section className="mt-8">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-[13.5px] font-semibold tracking-[-0.005em] text-ink">Today</h2>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            {tasks.length} items pulled in from connected tools
          </p>
        </div>
        <button className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-muted transition-colors duration-150 hover:bg-surface-subtle hover:text-ink">
          <span>All projects</span>
          <ChevronDown size={12} strokeWidth={1.75} />
        </button>
      </div>

      <div className="mt-3 overflow-hidden rounded-lg border border-border bg-surface shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </div>
    </section>
  );
}

function Sparkline({ tone }: { tone: "up" | "down" }) {
  const up = "M0,18 L8,15 L16,16 L24,11 L32,12 L40,8 L48,9 L56,4 L64,5";
  const down = "M0,6 L8,8 L16,7 L24,10 L32,11 L40,9 L48,13 L56,12 L64,16";
  const color = tone === "up" ? "var(--color-success)" : "var(--color-danger)";
  return (
    <svg viewBox="0 0 64 22" className="h-7 w-full" preserveAspectRatio="none" aria-hidden>
      <path
        d={tone === "up" ? up : down}
        fill="none"
        stroke={color}
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function KpiCard({
  label,
  value,
  delta,
  tone,
  note,
}: {
  label: string;
  value: string;
  delta: string;
  tone: "up" | "down";
  note: string;
}) {
  const TrendIcon = tone === "up" ? TrendingUp : TrendingDown;
  const trendColor = tone === "up" ? "text-success" : "text-danger";
  return (
    <div className="rounded-lg border border-border bg-surface p-3.5 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
          {label}
        </span>
        <span
          className={`inline-flex items-center gap-1 text-[11.5px] font-medium tabular-nums ${trendColor}`}
        >
          <TrendIcon size={11} strokeWidth={2} />
          {delta}
        </span>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-[22px] font-semibold tracking-[-0.02em] text-ink tabular-nums">
          {value}
        </span>
        <span className="text-[11.5px] text-ink-muted">{note}</span>
      </div>
      <div className="mt-2">
        <Sparkline tone={tone} />
      </div>
    </div>
  );
}

function KpiGrid() {
  return (
    <section className="mt-8">
      <div className="flex items-end justify-between">
        <h2 className="text-[13.5px] font-semibold tracking-[-0.005em] text-ink">This week</h2>
        <button className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-muted transition-colors duration-150 hover:bg-surface-subtle hover:text-ink">
          <span>Last 7 days</span>
          <ChevronDown size={12} strokeWidth={1.75} />
        </button>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <KpiCard label="Inbox cleared" value="42" delta="+18%" tone="up" note="vs last week" />
        <KpiCard
          label="Avg time to response"
          value="2h 14m"
          delta="−9%"
          tone="down"
          note="vs last week"
        />
      </div>
    </section>
  );
}

export default function InboxView() {
  return (
    <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-6 pb-16 pt-10">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Inbox</h1>
            <p className="mt-1 text-[13px] tracking-[-0.005em] text-ink-muted">
              One place to triage everything that needs your attention.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink-muted ring-1 ring-inset ring-border">
            <AlertCircle size={11} strokeWidth={1.85} className="text-warning" />
            {tasks.length} open
          </span>
        </div>

        <div className="mt-5">
          <ChatBox />
        </div>

        <TaskList />
        <KpiGrid />
      </div>
    </main>
  );
}
