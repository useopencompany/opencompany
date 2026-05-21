import Link from "next/link";
import { AtSign, Bot } from "lucide-react";
import { createAgent } from "@/lib/agents/actions";
import type { Agent, TiptapDoc } from "@/lib/db/schema";
import { AGENT_TOOLS, findTool, type AgentTool } from "@/components/agent-editor/tools";

type TiptapNode = {
  type?: string;
  attrs?: { id?: string } & Record<string, unknown>;
  content?: TiptapNode[];
};

function collectMentions(doc: TiptapDoc): AgentTool[] {
  const seen = new Set<string>();
  const out: AgentTool[] = [];
  const walk = (node: TiptapNode | undefined) => {
    if (!node) return;
    if (node.type === "mention" && node.attrs?.id) {
      const tool = findTool(node.attrs.id);
      if (tool && !seen.has(tool.id)) {
        seen.add(tool.id);
        out.push(tool);
      }
    }
    node.content?.forEach(walk);
  };
  walk(doc as TiptapNode);
  return out;
}

function MentionPill({ tool }: { tool: AgentTool }) {
  const Icon = tool.icon;
  return (
    <span className="inline-flex h-[18px] items-center gap-1 rounded-[5px] border border-[#e6e6e3] bg-[#fafaf8] px-1.5 text-[10.5px] font-medium text-ink/85">
      <Icon size={9.5} strokeWidth={1.9} className="text-ink-muted" />
      <span className="truncate max-w-[88px]">{tool.label}</span>
    </span>
  );
}

function MarkdownPreviewThumb({ mentions }: { mentions: AgentTool[] }) {
  const visible = mentions.slice(0, 4);
  const overflow = mentions.length - visible.length;
  return (
    <div className="relative h-[88px] w-[132px] shrink-0">
      <div className="absolute left-2 top-2 h-[78px] w-[122px] rounded-md border border-[#e6e6e3] bg-white" />
      <div className="relative h-[78px] w-[122px] overflow-hidden rounded-md border border-[#e4e4e0] bg-white p-2 shadow-[0_1px_2px_rgba(15,15,15,0.04)]">
        <div className="flex items-center gap-1 text-[9.5px] text-ink-subtle">
          <AtSign size={9} strokeWidth={1.9} />
          <span className="tracking-[-0.005em]">mentions</span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {visible.length === 0 ? (
            <span className="text-[10px] text-ink-subtle/80">none yet</span>
          ) : (
            visible.map((m) => <MentionPill key={m.id} tool={m} />)
          )}
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

function AgentRow({ agent }: { agent: Agent }) {
  const mentions = collectMentions(agent.content);
  return (
    <Link
      href={`/agents/${agent.id}`}
      className="group relative flex w-full items-center gap-4 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-[#ececea]/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/15"
    >
      <MarkdownPreviewThumb mentions={mentions} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[13.5px] font-medium tracking-[-0.005em] text-ink">
          {agent.name}
        </span>
        <span className="truncate text-[12px] text-ink-muted">
          {mentions.length > 0
            ? `${mentions.length} tool${mentions.length === 1 ? "" : "s"} mentioned`
            : "No tools mentioned yet"}
        </span>
      </div>
    </Link>
  );
}

function NewAgentButton({ label = "New Agent" }: { label?: string }) {
  return (
    <form action={createAgent}>
      <button
        type="submit"
        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#111] px-3 text-[12.5px] font-medium text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-black focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <Bot size={13} strokeWidth={1.9} />
        {label}
      </button>
    </form>
  );
}

export default function AgentsView({ agents }: { agents: Agent[] }) {
  const toolCount = AGENT_TOOLS.length;
  return (
    <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[680px] px-6 pb-16 pt-10">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">
              Agents
            </h1>
            <p className="mt-1 text-[13px] tracking-[-0.005em] text-ink-muted">
              Each agent is a natural-language brief. @-mention a tool to give
              it capabilities. {toolCount} tool available.
            </p>
          </div>
          <NewAgentButton />
        </div>

        {agents.length === 0 ? (
          <div className="mt-12 flex flex-col items-center justify-center rounded-lg border border-dashed border-[#e0e0db] bg-white/50 px-6 py-16 text-center">
            <Bot size={20} strokeWidth={1.7} className="text-ink-subtle" />
            <p className="mt-3 text-[13.5px] font-medium text-ink">
              No agents yet
            </p>
            <p className="mt-1 text-[12.5px] text-ink-muted">
              Create your first agent to describe how it should work.
            </p>
            <div className="mt-5">
              <NewAgentButton label="Create your first agent" />
            </div>
          </div>
        ) : (
          <div className="mt-8 flex flex-col gap-0.5">
            {agents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
