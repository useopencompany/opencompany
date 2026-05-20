import Sidebar from "@/components/Sidebar";
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Braces,
  CircleCheck,
  Database,
  Figma,
  Github,
  Globe2,
  MessageSquare,
  Plug,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";

const agents = [
  {
    name: "Product Engineer",
    description: "Ships UI flows, fixes regressions, and prepares clean PRs.",
    status: "Ready",
    accent: "#2563eb",
    integrations: [
      { label: "GitHub", icon: Github },
      { label: "Linear", icon: CircleCheck },
      { label: "Figma", icon: Figma },
    ],
    tools: [
      { label: "Terminal", icon: Terminal },
      { label: "Code Search", icon: Search },
      { label: "Browser", icon: Globe2 },
    ],
  },
  {
    name: "Research Analyst",
    description: "Finds context across docs, customer notes, and the web.",
    status: "Live",
    accent: "#0f766e",
    integrations: [
      { label: "Slack", icon: MessageSquare },
      { label: "Warehouse", icon: Database },
      { label: "Docs", icon: Braces },
    ],
    tools: [
      { label: "Web Search", icon: Globe2 },
      { label: "SQL", icon: Database },
      { label: "Summaries", icon: Sparkles },
    ],
  },
  {
    name: "Security Reviewer",
    description: "Checks auth changes, dependency risk, and release blockers.",
    status: "Idle",
    accent: "#b45309",
    integrations: [
      { label: "GitHub", icon: Github },
      { label: "Sentry", icon: ShieldCheck },
      { label: "PagerDuty", icon: Plug },
    ],
    tools: [
      { label: "Static Scan", icon: Search },
      { label: "Terminal", icon: Terminal },
      { label: "Policies", icon: ShieldCheck },
    ],
  },
];

function AvatarMark({ name, accent }: { name: string; accent: string }) {
  const initials = name
    .split(" ")
    .map((word) => word[0])
    .join("")
    .slice(0, 2);

  return (
    <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white bg-white shadow-[0_1px_2px_rgba(15,15,15,0.08),0_0_0_1px_rgba(15,15,15,0.04)]">
      <div
        className="absolute inset-1 rounded-md opacity-10"
        style={{ backgroundColor: accent }}
      />
      <span className="relative text-[13px] font-semibold tracking-[-0.005em] text-ink">
        {initials}
      </span>
    </div>
  );
}

function Chip({
  label,
  icon: Icon,
}: {
  label: string;
  icon: LucideIcon;
}) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-md border border-[#e4e4e0] bg-white px-2 text-[11.5px] font-medium text-ink/85 shadow-[0_1px_1px_rgba(15,15,15,0.02)]">
      <Icon size={12} strokeWidth={1.75} className="text-ink-muted" />
      {label}
    </span>
  );
}

function AgentCard({
  agent,
}: {
  agent: (typeof agents)[number];
}) {
  return (
    <button className="group flex w-full flex-col rounded-lg border border-[#e4e4e0] bg-white p-3 text-left shadow-[0_1px_2px_rgba(15,15,15,0.03)] transition-colors duration-150 hover:border-[#d8d8d2] hover:bg-[#fcfcfa] focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/15">
      <div className="flex items-start gap-3">
        <AvatarMark name={agent.name} accent={agent.accent} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[14px] font-semibold tracking-[-0.006em] text-ink">
              {agent.name}
            </h2>
            <span className="inline-flex items-center gap-1 rounded-full bg-[#f4f4f1] px-2 py-[2px] text-[10.5px] font-medium text-ink-muted ring-1 ring-inset ring-[#e6e6e3]">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: agent.accent }}
              />
              {agent.status}
            </span>
          </div>
          <p className="mt-1 text-[12.5px] leading-5 tracking-[-0.005em] text-ink-muted">
            {agent.description}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 border-t border-[#efefec] pt-3 sm:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
            <Plug size={11} strokeWidth={1.75} />
            Integrations
          </div>
          <div className="flex flex-wrap gap-1.5">
            {agent.integrations.map((integration) => (
              <Chip key={integration.label} {...integration} />
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
            <Bot size={11} strokeWidth={1.75} />
            Tools
          </div>
          <div className="flex flex-wrap gap-1.5">
            {agent.tools.map((tool) => (
              <Chip key={tool.label} {...tool} />
            ))}
          </div>
        </div>
      </div>
    </button>
  );
}

export default function AgentsPage() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas">
      <Sidebar />
      <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-6 pb-12 pt-10">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">
                Agents
              </h1>
              <p className="mt-1 text-[13px] tracking-[-0.005em] text-ink-muted">
                Reusable agents with their connected context, integrations, and tools.
              </p>
            </div>
            <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#111] px-3 text-[12.5px] font-medium text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-black focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20">
              <Bot size={13} strokeWidth={1.9} />
              New Agent
            </button>
          </div>

          <div className="mt-6 grid gap-3">
            {agents.map((agent) => (
              <AgentCard key={agent.name} agent={agent} />
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
