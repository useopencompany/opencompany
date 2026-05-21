import type { Agent } from "@opencompany/db/schema";
import { AtSign, Bot } from "lucide-react";
import Link from "next/link";
import {
  AGENT_MODELS,
  AGENT_TOOLS,
  findMentionItem,
  type AgentMentionItem,
} from "@/components/agent-editor/tools";
import { createAgent } from "@/lib/agents/actions";

function collectMentions(agent: Agent): AgentMentionItem[] {
  const model = findMentionItem(`model:${agent.config.model.name}`);
  const tools = agent.config.tools.flatMap((tool) => {
    const item = findMentionItem(`tool:${tool.id}`);
    return item ? [item] : [];
  });

  return model ? [model, ...tools] : tools;
}

function MentionPill({ item }: { item: AgentMentionItem }) {
  const Icon = item.icon;
  return (
    <span className="inline-flex h-[18px] items-center gap-1 rounded-[5px] border border-[#e6e6e3] bg-[#fafaf8] px-1.5 text-[10.5px] font-medium text-ink/85">
      <Icon size={9.5} strokeWidth={1.9} className="text-ink-muted" />
      <span className="truncate max-w-[88px]">{item.label}</span>
    </span>
  );
}

function MarkdownPreviewThumb({ mentions }: { mentions: AgentMentionItem[] }) {
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
            visible.map((m) => <MentionPill key={m.mentionId} item={m} />)
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
  const mentions = collectMentions(agent);
  const models = mentions.filter((mention) => mention.kind === "model");
  const tools = mentions.filter((mention) => mention.kind === "tool");
  const selectedModel = models.at(-1);
  const href = `/agents/${agent.path ?? agent.id}`;
  const syncLabel =
    agent.githubSyncStatus === "failed"
      ? "GitHub sync failed"
      : agent.githubSyncStatus === "pending" || agent.githubSyncStatus === "syncing"
        ? "Syncing"
        : "Synced";
  return (
    <Link
      href={href}
      className="group relative flex w-full items-center gap-4 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-[#ececea]/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/15"
    >
      <MarkdownPreviewThumb mentions={mentions} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[13.5px] font-medium tracking-[-0.005em] text-ink">{agent.name}</span>
        <span className="truncate text-[12px] text-ink-muted">
          {selectedModel
            ? `${selectedModel.label} model, ${tools.length} tool${
                tools.length === 1 ? "" : "s"
              }`
            : tools.length > 0
              ? `${tools.length} tool${tools.length === 1 ? "" : "s"} mentioned`
              : "Default model, no tools mentioned yet"}
        </span>
        <span className="text-[11px] text-ink-subtle">{syncLabel}</span>
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
  const modelCount = AGENT_MODELS.length;
  return (
    <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[680px] px-6 pb-16 pt-10">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Agents</h1>
            <p className="mt-1 text-[13px] tracking-[-0.005em] text-ink-muted">
              Each agent is a natural-language brief. @-mention a model or tool
              to shape how it runs. {modelCount} models and {toolCount} tool
              available.
            </p>
          </div>
          <NewAgentButton />
        </div>

        {agents.length === 0 ? (
          <div className="mt-12 flex flex-col items-center justify-center rounded-lg border border-dashed border-[#e0e0db] bg-white/50 px-6 py-16 text-center">
            <Bot size={20} strokeWidth={1.7} className="text-ink-subtle" />
            <p className="mt-3 text-[13.5px] font-medium text-ink">No agents yet</p>
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
