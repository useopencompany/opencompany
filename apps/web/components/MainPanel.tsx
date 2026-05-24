"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { createAgentSessionFromPrompt } from "@/lib/agent-sessions/actions";
import { seedSessionQueries } from "@/lib/agent-sessions/payload";
import {
  AGENTS_QUERY_STALE_TIME_MS,
  type AgentPayload,
  agentQueryKeys,
  fetchAgents,
} from "@/lib/agents/payload";

type AgentOption = {
  id: string;
  name: string;
};

function Prompt({ agents }: { agents: AgentOption[] }) {
  const { workspaceId } = useWorkspaceContext();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [input, setInput] = useState("");
  const [selectedAgentIdOverride, setSelectedAgentIdOverride] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const selectedAgentId = selectedAgentIdOverride || agents.at(0)?.id || "";
  const canSubmit = Boolean(input.trim() && selectedAgentId && !isPending);

  const submit = () => {
    const content = input.trim();
    if (!content || !selectedAgentId || isPending) return;

    setError(null);
    startTransition(async () => {
      const result = await createAgentSessionFromPrompt(selectedAgentId, content);
      if (result?.ok === false) {
        if ("redirectTo" in result) {
          router.push(result.redirectTo);
          return;
        }
        setError(result.error);
        return;
      }
      if (result?.ok) {
        seedSessionQueries(queryClient, workspaceId, result.detail);
        router.push(`/session/${result.session.id}`);
      }
    });
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="rounded-xl border border-[#e4e4e0] bg-white px-4 pt-3.5 pb-2.5 shadow-[0_1px_2px_rgba(15,15,15,0.03),0_0_0_1px_rgba(15,15,15,0.01)] transition-shadow duration-200 focus-within:border-[#d4d4cf] focus-within:shadow-[0_1px_2px_rgba(15,15,15,0.04),0_0_0_3px_rgba(15,15,15,0.04)]"
    >
      <textarea
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        rows={2}
        placeholder="Ask Open Company to build, fix bugs, explore"
        className="min-h-12 w-full resize-none bg-transparent text-[14px] leading-6 tracking-[-0.005em] text-ink placeholder:text-ink-subtle outline-none"
      />
      <div className="mt-6 flex items-center">
        <Select
          disabled={agents.length === 0}
          value={selectedAgentId}
          onValueChange={setSelectedAgentIdOverride}
        >
          <SelectTrigger
            aria-label="Agent"
            className="h-7 w-auto max-w-[240px] border-transparent bg-transparent py-1 pl-1.5 pr-2 text-[12.5px] text-ink/90 shadow-none hover:bg-[#f3f3f0] focus:ring-1 focus:ring-ink/20 data-[placeholder]:text-ink-subtle"
          >
            <SelectValue placeholder="No agents available" />
          </SelectTrigger>
          <SelectContent align="start" className="max-w-[280px]">
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {error ? <p className="ml-3 text-[12px] text-[#b42318]">{error}</p> : null}
        <button
          type="submit"
          disabled={!canSubmit}
          className="ml-auto flex h-8 w-8 items-center justify-center rounded-full bg-[#111] text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-black disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Start session"
        >
          <ArrowUp size={14} strokeWidth={2.25} />
        </button>
      </div>
    </form>
  );
}

export default function MainPanel({ agents: initialAgents }: { agents: AgentOption[] }) {
  const { workspaceId } = useWorkspaceContext();
  const queryClient = useQueryClient();
  const cachedAgents = queryClient.getQueryData<AgentPayload[]>(agentQueryKeys.list(workspaceId));
  const { data: agents = cachedAgents } = useQuery({
    queryKey: agentQueryKeys.list(workspaceId),
    queryFn: fetchAgents,
    staleTime: AGENTS_QUERY_STALE_TIME_MS,
  });
  const agentOptions =
    agents?.map((agent) => ({ id: agent.id, name: agent.name })) ?? initialAgents;

  return (
    <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[680px] px-6 pt-10">
        <Prompt agents={agentOptions} />
      </div>
    </main>
  );
}
