import {
  AnthropicIcon,
  GitHubIcon,
  GmailIcon,
  LinearIcon,
  OpenAIIcon,
  SlackIcon,
} from "@opencompany/ui/icons";
import { cn } from "@opencompany/ui/lib/utils";
import { Mark } from "../Mark";

/*
 * Static product mockups.
 *
 * These are DOM, not screenshots: the reference design crops its app UI hard
 * against a panel edge, which only stays sharp if the UI is real markup. They
 * are decorative — `aria-hidden` on the panel keeps the whole tree out of the
 * accessibility tree, so the surrounding prose carries the meaning.
 *
 * Everything here is intentionally small (11–13px) and 36px-per-row, matching
 * the density of the real app rather than an enlarged marketing render.
 */

/** Light recessed panel that crops an app card against its right and bottom edges. */
export function Panel({
  children,
  className,
  height = "h-[420px] sm:h-[610px]",
}: {
  children: React.ReactNode;
  className?: string;
  height?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative overflow-hidden rounded-[8px] border border-border bg-[#f1f1ef]",
        height,
        className,
      )}
    >
      {children}
    </div>
  );
}

/** White app card. Sized in fixed pixels so the panel crop is deliberate. */
function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[8px] border border-border bg-white shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("text-[11px] text-foreground/45 leading-none", className)}>{children}</p>;
}

const STATUS_STYLES = {
  merged: "bg-success-bg text-success",
  review: "bg-info-bg text-info",
  running: "bg-warning-bg text-warning",
  queued: "bg-foreground/[0.05] text-foreground/50",
} as const;

function Status({ kind, children }: { kind: keyof typeof STATUS_STYLES; children: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[4px] px-1.5 py-0.5 text-[11px] leading-[1.4]",
        STATUS_STYLES[kind],
      )}
    >
      {children}
    </span>
  );
}

/** Stacked initials, standing in for assignee avatars. */
function Avatars({ people }: { people: string[] }) {
  return (
    <span className="flex items-center">
      {people.map((initials, i) => (
        <span
          key={initials}
          className={cn(
            "inline-flex size-[18px] items-center justify-center rounded-full border border-white bg-[#e8e8e4] text-[9px] text-foreground/60",
            i > 0 && "-ml-1.5",
          )}
        >
          {initials}
        </span>
      ))}
    </span>
  );
}

function SidebarItem({
  children,
  active,
  icon,
}: {
  children: React.ReactNode;
  active?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex h-[26px] items-center gap-2 rounded-[4px] px-2 text-[12px] text-foreground/75",
        active && "bg-foreground/[0.06] text-foreground",
      )}
    >
      {icon ? (
        <span className="flex size-3 shrink-0 items-center justify-center">{icon}</span>
      ) : null}
      <span className="truncate">{children}</span>
    </div>
  );
}

function SidebarGroup({ children }: { children: string }) {
  return <Label className="mt-4 mb-1 px-2 uppercase tracking-[0.06em]">{children}</Label>;
}

/** The app's left rail, shared by every mockup that shows full chrome. */
function Sidebar({ active }: { active: string }) {
  return (
    <div className="flex w-[186px] shrink-0 flex-col border-border border-r bg-[#fafaf9] p-2">
      <div className="flex h-[26px] items-center gap-2 px-2">
        <Mark className="size-3.5 text-foreground/70" />
        <span className="truncate text-[12px] text-foreground">opencompany</span>
      </div>

      <div className="mt-3 space-y-px">
        {["Home", "For review", "Wiki", "Workflows", "Tasks"].map((item) => (
          <SidebarItem key={item} active={item === active}>
            {item}
          </SidebarItem>
        ))}
      </div>

      <SidebarGroup>Chats</SidebarGroup>
      <div className="space-y-px">
        {[
          "Draft the launch post",
          "Why did signups dip?",
          "Fix the invite email",
          "Competitor teardown",
          "Prep the partner call",
          "Reconcile invoices",
          "Rewrite onboarding",
        ].map((item) => (
          <SidebarItem key={item}>{item}</SidebarItem>
        ))}
      </div>

      <SidebarGroup>Workflows</SidebarGroup>
      <div className="space-y-px">
        {["Triage bug reports", "Weekly update", "Churn watch"].map((item) => (
          <SidebarItem key={item}>{item}</SidebarItem>
        ))}
      </div>

      <SidebarGroup>Sources</SidebarGroup>
      <div className="space-y-px">
        <SidebarItem icon={<SlackIcon className="size-3" />}>Slack</SidebarItem>
        <SidebarItem icon={<GitHubIcon className="size-3" />}>GitHub</SidebarItem>
        <SidebarItem icon={<LinearIcon className="size-3" />}>Linear</SidebarItem>
        <SidebarItem icon={<GmailIcon className="size-3" />}>Gmail</SidebarItem>
      </div>

      {/* Account row sits at the bottom of the rail, as it does in the app. */}
      <div className="mt-auto flex items-center gap-2 border-border border-t px-2 pt-2.5">
        <span className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-full bg-[#e8e8e4] text-[9px] text-foreground/60">
          LM
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[12px] text-foreground">Louis</span>
          <span className="block text-[11px] text-foreground/45">Pro · 4 seats</span>
        </span>
      </div>
    </div>
  );
}

function PaneHeader({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="flex h-[38px] items-center gap-2 border-border border-b px-3">
      <span className="text-[12px] text-foreground">{title}</span>
      {meta ? (
        <span className="rounded-[4px] bg-foreground/[0.05] px-1.5 py-0.5 text-[11px] text-foreground/60">
          {meta}
        </span>
      ) : null}
    </div>
  );
}

const TASKS = [
  {
    task: "Ship dark mode for the wiki",
    status: "review",
    agent: "Claude Code",
    when: "2m ago",
    src: "Linear",
  },
  {
    task: "Fix invite email copy",
    status: "merged",
    agent: "Codex",
    when: "18m ago",
    src: "Slack",
  },
  {
    task: "Reply to the Acme security review",
    status: "running",
    agent: "Claude",
    when: "1h ago",
    src: "Gmail",
  },
  {
    task: "Draft the 1.27 changelog",
    status: "merged",
    agent: "Claude",
    when: "3h ago",
    src: "GitHub",
  },
  {
    task: "Triage new Slack bug reports",
    status: "running",
    agent: "Claude Code",
    when: "4h ago",
    src: "Slack",
  },
  {
    task: "Refresh the pricing page",
    status: "queued",
    agent: "Codex",
    when: "Yesterday",
    src: "Linear",
  },
  {
    task: "Summarize last week's decisions",
    status: "merged",
    agent: "Claude",
    when: "Yesterday",
    src: "Slack",
  },
  {
    task: "Chase the unpaid Stripe invoice",
    status: "queued",
    agent: "Claude",
    when: "Yesterday",
    src: "Gmail",
  },
  {
    task: "Retry the failed GitHub source sync",
    status: "merged",
    agent: "Codex",
    when: "2d ago",
    src: "GitHub",
  },
  {
    task: "Write the onboarding follow-up",
    status: "review",
    agent: "Claude",
    when: "2d ago",
    src: "Gmail",
  },
  {
    task: "Add seat limits to the billing page",
    status: "merged",
    agent: "Claude Code",
    when: "2d ago",
    src: "Linear",
  },
  {
    task: "Answer the SSO question in #sales",
    status: "merged",
    agent: "Claude",
    when: "3d ago",
    src: "Slack",
  },
  {
    task: "Deduplicate the competitor pages",
    status: "queued",
    agent: "Codex",
    when: "3d ago",
    src: "Linear",
  },
  {
    task: "Fix the wiki search ranking",
    status: "review",
    agent: "Claude Code",
    when: "4d ago",
    src: "GitHub",
  },
  {
    task: "Draft the Q4 investor update",
    status: "running",
    agent: "Claude",
    when: "4d ago",
    src: "Gmail",
  },
  {
    task: "Rotate the expiring API tokens",
    status: "merged",
    agent: "Codex",
    when: "5d ago",
    src: "GitHub",
  },
  {
    task: "Reconcile the September invoices",
    status: "merged",
    agent: "Claude",
    when: "5d ago",
    src: "Stripe",
  },
  {
    task: "Prep the design partner call",
    status: "queued",
    agent: "Claude",
    when: "6d ago",
    src: "Slack",
  },
] as const;

const TASK_COLUMNS = "grid grid-cols-[400px_124px_140px_104px_96px_120px]";

const STATUS_LABELS = {
  merged: "Merged",
  review: "In review",
  running: "Running",
  queued: "Queued",
} as const;

const AGENT_ICONS: Record<string, React.ReactNode> = {
  "Claude Code": <AnthropicIcon className="size-3 text-[#D97757]" />,
  Claude: <AnthropicIcon className="size-3 text-[#D97757]" />,
  Codex: <OpenAIIcon className="size-3 text-foreground/80" />,
};

/**
 * Hero mockup: the workspace with the task list open, plus a floating toast for
 * the wiki refresh. Fixed at 1180px wide so the right-hand columns crop off the
 * viewport edge exactly the way the reference hero does.
 */
export function WorkspaceMockup() {
  return (
    <div aria-hidden="true" className="w-[1180px]">
      <Card className="mb-3 w-[504px] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="size-1.5 shrink-0 rounded-full bg-violet-500" />
          <span className="text-[12px] text-foreground">Nightly wiki refresh</span>
          <span className="truncate text-[12px] text-foreground/50">
            Filing 42 new sources from Slack and GitHub…
          </span>
        </div>
      </Card>

      <Card className="flex">
        <Sidebar active="Tasks" />
        <div className="min-w-0 flex-1">
          <PaneHeader title="Tasks" meta="All" />
          <div className="flex h-[30px] items-center border-border border-b px-3">
            <Label>Filter · 18 open</Label>
          </div>
          <div className={cn(TASK_COLUMNS, "border-border border-b px-3 py-2")}>
            {["Task", "Status", "Agent", "Updated", "Owner", "Source"].map((col) => (
              <Label key={col}>{col}</Label>
            ))}
          </div>
          {TASKS.map((row) => (
            <div
              key={row.task}
              className={cn(TASK_COLUMNS, "h-9 items-center border-border border-b px-3")}
            >
              <span className="truncate pr-4 text-[12px] text-foreground">{row.task}</span>
              <span>
                <Status kind={row.status}>{STATUS_LABELS[row.status]}</Status>
              </span>
              <span className="flex items-center gap-1.5 text-[12px] text-foreground/70">
                {AGENT_ICONS[row.agent]}
                {row.agent}
              </span>
              <span className="text-[12px] text-foreground/45">{row.when}</span>
              <Avatars people={["LM", "JS"]} />
              <span className="text-[12px] text-foreground/45">{row.src}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/** Solutions row 1: a PR waiting in the review queue. */
export function ReviewMockup() {
  return (
    <div aria-hidden="true" className="absolute top-12 left-[72px] flex w-[1000px] gap-3">
      <Card className="h-[640px] w-[276px] shrink-0">
        <PaneHeader title="For review" meta="9" />
        <Label className="px-3 pt-3 pb-2 uppercase tracking-[0.06em]">Pull requests</Label>
        {[
          { title: "Ship dark mode for the wiki", repo: "web", when: "2m", active: true },
          { title: "Fix invite email copy", repo: "web", when: "18m" },
          { title: "Retry failed source syncs", repo: "runner", when: "1h" },
          { title: "Refresh the pricing page", repo: "marketing", when: "3h" },
          { title: "Add seat limits to billing", repo: "web", when: "5h" },
          { title: "Fix wiki search ranking", repo: "packages/wiki", when: "Yesterday" },
          { title: "Rotate expiring API tokens", repo: "runner", when: "Yesterday" },
          { title: "Deduplicate competitor pages", repo: "packages/brain", when: "2d" },
          { title: "Cache the changelog feed", repo: "marketing", when: "3d" },
        ].map((item) => (
          <div
            key={item.title}
            className={cn(
              "flex h-[46px] items-center gap-2 border-border border-b px-3",
              item.active && "bg-foreground/[0.04]",
            )}
          >
            <GitHubIcon className="size-3.5 shrink-0 text-foreground/60" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] text-foreground">{item.title}</span>
              <span className="block text-[11px] text-foreground/45">{item.repo}</span>
            </span>
            <span className="text-[11px] text-foreground/45">{item.when}</span>
          </div>
        ))}
      </Card>

      <Card className="h-[640px] min-w-0 flex-1">
        <PaneHeader title="Ship dark mode for the wiki" meta="#1284" />
        <div className="space-y-3 p-3">
          <div className="flex items-center gap-2">
            <AnthropicIcon className="size-3 text-[#D97757]" />
            <span className="text-[12px] text-foreground/70">
              Claude Code · 14 files changed · sandbox run 4m 12s
            </span>
          </div>
          <div className="rounded-[6px] border border-border bg-[#fafaf9] p-3">
            <Label className="mb-2 uppercase tracking-[0.06em]">What changed</Label>
            <p className="text-[12px] text-foreground/80 leading-[1.6]">
              Wiki pages now read the workspace theme token instead of hard-coding the light
              palette. Follows the pattern already used by the chat surface, so no new provider was
              added.
            </p>
          </div>
          <div className="flex flex-wrap gap-4">
            {[
              ["Typecheck", "merged"],
              ["Unit tests", "merged"],
              ["Lint", "merged"],
              ["Preview deploy", "running"],
            ].map(([check, kind]) => (
              <span key={check} className="flex items-center gap-1.5">
                <Status kind={kind as keyof typeof STATUS_STYLES}>
                  {kind === "merged" ? "Passed" : "Running"}
                </Status>
                <span className="text-[12px] text-foreground/60">{check}</span>
              </span>
            ))}
          </div>
          <div className="overflow-hidden rounded-[6px] border border-border">
            <div className="flex items-center gap-2 border-border border-b bg-[#fafaf9] px-3 py-1.5">
              <Label>packages/wiki/src/page-theme.ts</Label>
            </div>
            <div className="font-mono text-[11px] leading-[1.8]">
              {[
                ["-", 'background: "#ffffff",', "bg-[#fdecea]"],
                ["+", 'background: "var(--card)",', "bg-[#eaf6ec]"],
                ["+", 'color: "var(--card-foreground)",', "bg-[#eaf6ec]"],
                ["-", 'border: "1px solid #e6e6e3",', "bg-[#fdecea]"],
                ["+", 'border: "1px solid var(--border)",', "bg-[#eaf6ec]"],
              ].map(([sign, code, tone]) => (
                <div key={code} className={cn("px-3 text-foreground/70", tone)}>
                  <span className="mr-2 text-foreground/35">{sign}</span>
                  {code}
                </div>
              ))}
            </div>
          </div>
          <div className="overflow-hidden rounded-[6px] border border-border">
            <div className="flex items-center gap-2 border-border border-b bg-[#fafaf9] px-3 py-1.5">
              <Label>apps/web/app/(app)/wiki/page.tsx</Label>
            </div>
            <div className="font-mono text-[11px] leading-[1.8]">
              {[
                ["-", "<WikiPage theme={lightTheme} />", "bg-[#fdecea]"],
                ["+", "<WikiPage theme={workspaceTheme} />", "bg-[#eaf6ec]"],
                ["+", "// theme comes from the workspace, not the route", "bg-[#eaf6ec]"],
              ].map(([sign, code, tone]) => (
                <div key={code} className={cn("px-3 text-foreground/70", tone)}>
                  <span className="mr-2 text-foreground/35">{sign}</span>
                  {code}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** Solutions row 2: the self-building wiki, mid-refresh. */
export function WikiMockup() {
  return (
    <div aria-hidden="true" className="absolute top-12 left-[72px] w-[1000px]">
      <Card className="flex h-[640px]">
        <Sidebar active="Wiki" />
        <div className="w-[190px] shrink-0 border-border border-r p-2">
          <Label className="mb-2 px-2 uppercase tracking-[0.06em]">Company</Label>
          <div className="space-y-px">
            {[
              "decisions",
              "product",
              "customers",
              "people",
              "metrics",
              "playbooks",
              "competitors",
              "onboarding",
              "security",
              "hiring",
              "runbooks",
            ].map((item) => (
              <SidebarItem key={item} active={item === "decisions"}>
                {item}
              </SidebarItem>
            ))}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <PaneHeader title="decisions / pricing-model" meta="Updated 6m ago" />
          <div className="space-y-4 p-4">
            <h4 className="text-[15px] text-foreground">Why usage-based, not per-seat</h4>
            <p className="max-w-[420px] text-[12px] text-foreground/70 leading-[1.7]">
              Small teams add agents faster than they add people, so per-seat pricing punishes the
              behaviour we want. We bill a monthly balance and pass provider cost through at par.
            </p>
            <div>
              <Label className="mb-2 uppercase tracking-[0.06em]">Compiled from</Label>
              <div className="space-y-1.5">
                {[
                  { icon: <SlackIcon className="size-3" />, text: "#pricing — 41 messages" },
                  { icon: <LinearIcon className="size-3" />, text: "BIL-204 Usage billing v2" },
                  { icon: <GmailIcon className="size-3" />, text: "Re: pricing feedback (3)" },
                  { icon: <GitHubIcon className="size-3" />, text: "#1190 Meter agent usage" },
                  {
                    icon: <SlackIcon className="size-3" />,
                    text: "#design-partners — 12 messages",
                  },
                ].map((item) => (
                  <div
                    key={item.text}
                    className="flex items-center gap-2 text-[12px] text-foreground/60"
                  >
                    <span className="flex size-3 items-center justify-center">{item.icon}</span>
                    {item.text}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <Label className="mb-2 uppercase tracking-[0.06em]">Open questions</Label>
              <p className="max-w-[420px] text-[12px] text-foreground/70 leading-[1.7]">
                Top-ups are still undecided. BIL-204 is unassigned and blocks the Pro launch
                checklist, so this page will change again before launch.
              </p>
            </div>
            <div>
              <Label className="mb-2 uppercase tracking-[0.06em]">Linked pages</Label>
              <div className="space-y-1.5">
                {[
                  "decisions / seat-limits",
                  "metrics / included-usage",
                  "playbooks / answering-pricing-questions",
                ].map((page) => (
                  <p key={page} className="text-[12px] text-foreground/60">
                    {page}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** Solutions row 3: a workflow that has already run without anyone starting it. */
export function WorkflowMockup() {
  return (
    <div aria-hidden="true" className="absolute top-12 left-[72px] w-[1000px]">
      <Card>
        <PaneHeader title="Triage inbound bug reports" meta="Enabled" />
        <div className="flex items-center gap-2 border-border border-b px-3 py-2">
          <Label>Trigger</Label>
          <span className="flex items-center gap-1.5 text-[12px] text-foreground/70">
            <SlackIcon className="size-3" /> New message in #bugs
          </span>
        </div>
        <div className="grid grid-cols-[1fr_1fr] divide-x divide-border">
          <div className="p-3">
            <Label className="mb-2 uppercase tracking-[0.06em]">Steps</Label>
            <div className="space-y-2">
              {[
                "Read the report and the linked thread",
                "Search the wiki for prior reports and known workarounds",
                "Check whether the reporter is on a paid plan",
                "Open a Linear issue with a severity and an owner",
                "Reply in-thread with the issue link",
                "Hand the fix to Claude Code if it is small",
                "Escalate to a human if there is no reproduction",
              ].map((step, i) => (
                <div key={step} className="flex gap-2">
                  <span className="w-4 shrink-0 text-[11px] text-foreground/35">{i + 1}</span>
                  <span className="text-[12px] text-foreground/75 leading-[1.5]">{step}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="p-3">
            <Label className="mb-2 uppercase tracking-[0.06em]">Recent runs</Label>
            <div className="space-y-px">
              {[
                { when: "6m ago", out: "BUG-412 opened · replied", kind: "merged" },
                { when: "2h ago", out: "Duplicate of BUG-388", kind: "merged" },
                { when: "5h ago", out: "Fix handed to Claude Code", kind: "review" },
                { when: "Yesterday", out: "BUG-407 opened · replied", kind: "merged" },
                { when: "Yesterday", out: "Needs a human — no repro", kind: "running" },
                { when: "Yesterday", out: "BUG-404 opened · replied", kind: "merged" },
                { when: "2d ago", out: "Duplicate of BUG-371", kind: "merged" },
                { when: "2d ago", out: "Fix handed to Codex", kind: "review" },
                { when: "3d ago", out: "BUG-398 opened · replied", kind: "merged" },
                { when: "3d ago", out: "Closed — working as intended", kind: "merged" },
                { when: "4d ago", out: "Needs a human — paid plan", kind: "running" },
                { when: "5d ago", out: "BUG-390 opened · replied", kind: "merged" },
              ].map((run) => (
                <div key={run.when + run.out} className="flex h-8 items-center gap-2">
                  <span className="w-[74px] shrink-0 text-[11px] text-foreground/45">
                    {run.when}
                  </span>
                  <Status kind={run.kind as keyof typeof STATUS_STYLES}>
                    {run.kind === "merged" ? "Done" : run.kind === "review" ? "In review" : "Held"}
                  </Status>
                  <span className="truncate text-[12px] text-foreground/70">{run.out}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

/**
 * Teams section mockup: a chat answering a question that spans every source.
 * The answer text is supplied by the caller so the tab strip can swap it.
 */
export function ChatMockup({
  question,
  answer,
  bullets,
  closing,
}: {
  question: string;
  answer: string;
  bullets: string[];
  closing: string;
}) {
  return (
    <div aria-hidden="true" className="absolute top-10 left-1/2 w-[640px] -translate-x-1/2">
      <Card className="flex h-[560px] flex-col">
        <PaneHeader title="Ask opencompany" meta="Company wiki" />
        <div className="flex-1 space-y-4 p-4">
          <div className="flex justify-end">
            <p className="max-w-[440px] rounded-[6px] bg-foreground/[0.05] px-3 py-2 text-[12px] text-foreground leading-[1.6]">
              {question}
            </p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Mark className="size-3 text-foreground/70" />
              <Label>Read 214 wiki pages, 9 threads</Label>
            </div>
            <p className="text-[12px] text-foreground leading-[1.7]">{answer}</p>
            <ul className="space-y-1 pl-4">
              {bullets.map((bullet) => (
                <li
                  key={bullet}
                  className="list-disc text-[12px] text-foreground/75 leading-[1.7] marker:text-foreground/30"
                >
                  {bullet}
                </li>
              ))}
            </ul>
            <p className="text-[12px] text-foreground/75 leading-[1.7]">{closing}</p>
          </div>
        </div>
        <div className="border-border border-t p-4">
          <div className="rounded-[6px] border border-border px-3 py-2.5">
            <p className="text-[12px] text-foreground/35">Ask a follow-up…</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
