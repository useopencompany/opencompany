"use client";

import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AtSign,
  Bot,
  CircleCheck,
  CornerDownLeft,
  Database,
  FileText,
  GitBranch,
  Globe2,
  MessageSquare,
  PenTool,
  Plug,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  User,
  X,
} from "lucide-react";

type MentionType = "integration" | "tool" | "agent" | "page";

type Mention = {
  type: MentionType;
  label: string;
  icon: LucideIcon;
};

type Agent = {
  name: string;
  slug: string;
  summary: string;
  lastUsed: string;
  runs7d: number;
  mentions: Mention[];
  body: string;
};

const agents: Agent[] = [
  {
    name: "Product Engineer",
    slug: "product-engineer",
    summary: "Ships UI flows, fixes regressions, and prepares clean PRs.",
    lastUsed: "2h",
    runs7d: 14,
    mentions: [
      { type: "integration", label: "github", icon: GitBranch },
      { type: "integration", label: "linear", icon: CircleCheck },
      { type: "integration", label: "figma", icon: PenTool },
      { type: "tool", label: "terminal", icon: Terminal },
      { type: "tool", label: "code-search", icon: Search },
      { type: "page", label: "design-system.md", icon: FileText },
    ],
    body: `You ship product UI flows, fix regressions, and prepare clean pull requests for review.

## Context
Reference @design-system.md for component patterns and tokens before introducing new primitives.

## Workflow
Pick up work from @linear, implement and validate against @figma, then open the PR via @github. Use @terminal for local verification and @code-search to navigate the codebase.`,
  },
  {
    name: "Research Analyst",
    slug: "research-analyst",
    summary: "Finds context across docs, customer notes, and the web.",
    lastUsed: "1d",
    runs7d: 8,
    mentions: [
      { type: "integration", label: "slack", icon: MessageSquare },
      { type: "integration", label: "warehouse", icon: Database },
      { type: "tool", label: "web-search", icon: Globe2 },
      { type: "tool", label: "sql", icon: Database },
      { type: "tool", label: "summaries", icon: Sparkles },
      { type: "page", label: "customer-notes.md", icon: FileText },
      { type: "page", label: "okrs.md", icon: FileText },
    ],
    body: `You find context across the company — docs, customer notes, and the open web.

## Context
Pull from @customer-notes.md and @okrs.md before drafting any summary. Pipe analytical questions to @sql against @warehouse.

## Workflow
Search @slack for prior discussion, run @web-search for outside context, and produce @summaries that cite sources.`,
  },
  {
    name: "Security Reviewer",
    slug: "security-reviewer",
    summary: "Checks auth changes, dependency risk, and release blockers.",
    lastUsed: "5d",
    runs7d: 2,
    mentions: [
      { type: "integration", label: "github", icon: GitBranch },
      { type: "integration", label: "sentry", icon: ShieldCheck },
      { type: "integration", label: "pagerduty", icon: Plug },
      { type: "tool", label: "static-scan", icon: Search },
      { type: "tool", label: "policies", icon: ShieldCheck },
      { type: "agent", label: "product-engineer", icon: User },
      { type: "page", label: "auth-runbook.md", icon: FileText },
    ],
    body: `You review auth changes, dependency risk, and release blockers before they ship.

## Context
Cross-check against @auth-runbook.md. Pair with @product-engineer when fixes are needed in product code.

## Workflow
Run @static-scan on the diff from @github. Check @sentry for related alerts and @pagerduty for active incidents. Verify changes against @policies.`,
  },
];

function MentionPill({ mention }: { mention: Mention }) {
  const Icon = mention.icon;
  return (
    <span className="inline-flex h-[18px] items-center gap-1 rounded-[5px] border border-[#e6e6e3] bg-[#fafaf8] px-1.5 text-[10.5px] font-medium text-ink/85">
      <Icon size={9.5} strokeWidth={1.9} className="text-ink-muted" />
      <span className="truncate max-w-[88px]">{mention.label}</span>
    </span>
  );
}

function InlineMention({ mention }: { mention: Mention }) {
  const Icon = mention.icon;
  return (
    <span className="inline-flex h-[20px] items-center gap-1 rounded-[5px] border border-[#e6e2d4] bg-white px-1.5 align-[-0.2em] text-[12px] font-medium text-ink/85">
      <Icon size={10.5} strokeWidth={1.9} className="text-ink-muted" />
      <span>{mention.label}</span>
    </span>
  );
}

function MarkdownPreviewThumb({ agent }: { agent: Agent }) {
  const visible = agent.mentions.slice(0, 4);
  const overflow = agent.mentions.length - visible.length;
  return (
    <div className="relative h-[88px] w-[132px] shrink-0">
      <div className="absolute left-2 top-2 h-[78px] w-[122px] rounded-md border border-[#e6e6e3] bg-white" />
      <div className="relative h-[78px] w-[122px] overflow-hidden rounded-md border border-[#e4e4e0] bg-white p-2 shadow-[0_1px_2px_rgba(15,15,15,0.04)]">
        <div className="flex items-center gap-1 text-[9.5px] text-ink-subtle">
          <AtSign size={9} strokeWidth={1.9} />
          <span className="tracking-[-0.005em]">mentions</span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {visible.map((m) => (
            <MentionPill key={`${m.type}-${m.label}`} mention={m} />
          ))}
          {overflow > 0 && (
            <span className="inline-flex h-[18px] items-center rounded-[5px] bg-[#f0f0ec] px-1.5 text-[10px] font-medium text-ink-muted">
              +{overflow}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentRow({
  agent,
  onOpen,
}: {
  agent: Agent;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className="group relative flex w-full items-center gap-4 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-[#ececea]/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/15"
    >
      <MarkdownPreviewThumb agent={agent} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[13.5px] font-medium tracking-[-0.005em] text-ink">
          {agent.name}
        </span>
        <span className="truncate text-[12px] text-ink-muted">
          {agent.summary}
        </span>
        <div className="flex items-center gap-2 text-[11.5px] text-ink-subtle">
          <span>last used {agent.lastUsed} ago</span>
          <span aria-hidden className="h-0.5 w-0.5 rounded-full bg-ink-subtle/60" />
          <span className="tabular-nums">{agent.runs7d} runs · 7d</span>
        </div>
      </div>
      <span className="absolute right-3 top-1/2 hidden -translate-y-1/2 items-center gap-1 rounded-md border border-[#e4e4e0] bg-white px-2 py-1 text-[11px] font-medium text-ink-muted shadow-[0_1px_2px_rgba(15,15,15,0.04)] group-hover:flex">
        <CornerDownLeft size={11} strokeWidth={1.9} />
        Start session
      </span>
    </button>
  );
}

function renderInline(text: string, mentions: Mention[]): React.ReactNode[] {
  const map = new Map(mentions.map((m) => [m.label, m]));
  const parts: React.ReactNode[] = [];
  const regex = /@([a-z0-9_\-./]+)/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const mention = map.get(match[1].toLowerCase());
    if (mention) {
      parts.push(<InlineMention key={`m-${key++}`} mention={mention} />);
    } else {
      parts.push(match[0]);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function MarkdownBody({ agent }: { agent: Agent }) {
  const blocks: React.ReactNode[] = [];
  const lines = agent.body.split("\n");
  let paragraphBuffer: string[] = [];

  const flushParagraph = (key: string) => {
    if (paragraphBuffer.length === 0) return;
    const text = paragraphBuffer.join(" ");
    blocks.push(
      <p key={key} className="text-[13.5px] leading-7 text-ink/90">
        {renderInline(text, agent.mentions)}
      </p>,
    );
    paragraphBuffer = [];
  };

  lines.forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (line === "") {
      flushParagraph(`p-${i}`);
      return;
    }
    if (line.startsWith("## ")) {
      flushParagraph(`p-${i}`);
      blocks.push(
        <h3
          key={`h-${i}`}
          className="mt-5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle"
        >
          {line.slice(3)}
        </h3>,
      );
      return;
    }
    paragraphBuffer.push(line);
  });
  flushParagraph("p-end");

  return <div className="mt-6 space-y-3.5">{blocks}</div>;
}

function AgentModal({
  agent,
  onClose,
}: {
  agent: Agent | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!agent) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = "";
    };
  }, [agent, onClose]);

  if (!agent) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/25 px-6 py-12 backdrop-blur-[2px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-[620px] overflow-hidden rounded-lg border border-[#e8e6dc] bg-[#fbfaf4] shadow-[0_40px_80px_-20px_rgba(0,0,0,0.35),0_15px_30px_-15px_rgba(0,0,0,0.2),0_0_0_1px_rgba(0,0,0,0.02)]"
        style={{
          backgroundImage:
            "linear-gradient(180deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0) 120px), repeating-linear-gradient(0deg, transparent 0px, transparent 27px, rgba(120, 110, 80, 0.04) 27px, rgba(120, 110, 80, 0.04) 28px)",
        }}
      >
        <div className="flex items-center justify-between border-b border-[#ece8d8] bg-[#f6f3e7]/60 px-5 py-2.5">
          <div className="flex items-center gap-2 text-ink-muted">
            <FileText size={12} strokeWidth={1.85} />
            <span className="font-mono text-[11.5px] tracking-[-0.005em]">
              {agent.slug}.md
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-ink-muted transition-colors hover:bg-[#ede9d8] hover:text-ink"
          >
            <X size={13} strokeWidth={1.9} />
          </button>
        </div>

        <div className="px-10 pb-8 pt-8">
          <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-ink">
            {agent.name}
          </h2>
          <p className="mt-1.5 text-[13px] tracking-[-0.005em] text-ink-muted">
            {agent.summary}
          </p>

          <MarkdownBody agent={agent} />
        </div>

        <div className="flex items-center justify-between border-t border-[#ece8d8] bg-[#f6f3e7]/40 px-5 py-2.5 text-[11.5px] text-ink-subtle">
          <span>
            last used {agent.lastUsed} ago{" "}
            <span aria-hidden className="mx-1.5 text-ink-subtle/70">
              ·
            </span>
            <span className="tabular-nums">{agent.runs7d} runs · 7d</span>
          </span>
          <button className="inline-flex items-center gap-1 rounded-md bg-[#111] px-2.5 py-1 text-[11.5px] font-medium text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors hover:bg-black">
            <CornerDownLeft size={11} strokeWidth={1.9} />
            Start session
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AgentsView() {
  const [openAgent, setOpenAgent] = useState<Agent | null>(null);

  return (
    <>
      <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-[680px] px-6 pb-16 pt-10">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">
                Agents
              </h1>
              <p className="mt-1 text-[13px] tracking-[-0.005em] text-ink-muted">
                Each agent is a markdown file. @-mention tools, integrations,
                pages, and other agents to give it context.
              </p>
            </div>
            <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#111] px-3 text-[12.5px] font-medium text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-black focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20">
              <Bot size={13} strokeWidth={1.9} />
              New Agent
            </button>
          </div>

          <div className="mt-8 flex flex-col gap-0.5">
            {agents.map((agent) => (
              <AgentRow
                key={agent.name}
                agent={agent}
                onOpen={() => setOpenAgent(agent)}
              />
            ))}
          </div>
        </div>
      </main>

      <AgentModal agent={openAgent} onClose={() => setOpenAgent(null)} />
    </>
  );
}
