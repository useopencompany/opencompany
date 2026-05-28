"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { useToast } from "@/components/ToastProvider";
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
  type AgentListItemPayload,
  agentQueryKeys,
  fetchAgents,
} from "@/lib/agents/payload";

const TEXTAREA_MAX_HEIGHT_PX = 220;

type AgentOption = {
  id: string;
  name: string;
};

function Prompt({ agents }: { agents: AgentOption[] }) {
  const { workspaceId } = useWorkspaceContext();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { showToast } = useToast();
  const [input, setInput] = useState("");
  const [selectedAgentIdOverride, setSelectedAgentIdOverride] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const compositionEndAtRef = useRef(0);
  const selectedAgentId = selectedAgentIdOverride || agents.at(0)?.id || "";
  const canSubmit = Boolean(input.trim() && selectedAgentId && !isPending);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (input.length === 0) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, [input]);

  const submit = () => {
    const content = input.trim();
    if (!content || isPending) return;
    if (!selectedAgentId) {
      setError("Create an agent first before starting a session.");
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await createAgentSessionFromPrompt(selectedAgentId, content);
      if (!result.ok) {
        if ("redirectTo" in result) {
          router.push(result.redirectTo);
          return;
        }
        setError(result.error);
        return;
      }
      seedSessionQueries(queryClient, workspaceId, result.detail);
      router.push(`/session/${result.session.id}`);
    });
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="group/prompt rounded-xl border border-[#e4e4e0] bg-white px-4 pt-3.5 pb-2.5 shadow-[0_1px_2px_rgba(15,15,15,0.03),0_0_0_1px_rgba(15,15,15,0.01)] transition-shadow duration-200 focus-within:border-[#d4d4cf] focus-within:shadow-[0_1px_2px_rgba(15,15,15,0.04),0_0_0_3px_rgba(15,15,15,0.04)]"
    >
      <textarea
        ref={textareaRef}
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onCompositionEnd={() => {
          compositionEndAtRef.current = performance.now();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          if (event.nativeEvent.isComposing) return;
          if (performance.now() - compositionEndAtRef.current < 50) return;
          event.preventDefault();
          submit();
        }}
        onPaste={(event) => {
          const items = event.clipboardData?.items;
          if (!items) return;
          const itemArray = Array.from(items);
          const hasImage = itemArray.some(
            (item) => item.kind === "file" && item.type.startsWith("image/"),
          );
          if (!hasImage) return;
          const hasText = itemArray.some((item) => item.kind === "string");
          if (!hasText) event.preventDefault();
          showToast({
            title: "Image upload coming soon",
            description: hasText
              ? "The text was pasted; the image was ignored."
              : "Image attachments aren't supported yet.",
            tone: "default",
          });
        }}
        rows={1}
        placeholder="Ask Open Company to build, fix bugs, explore"
        className="min-h-9 w-full resize-none content-center bg-transparent text-[14px] leading-6 tracking-[-0.005em] text-ink placeholder:text-ink-subtle outline-none"
        style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
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
          className="ml-auto flex h-9 w-9 items-center justify-center rounded-full bg-[#111] text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-black disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={isPending ? "Starting session…" : "Start session"}
        >
          {isPending ? (
            <LoaderCircle size={13} strokeWidth={2} className="animate-spin" />
          ) : (
            <ArrowUp size={13} strokeWidth={2} />
          )}
        </button>
      </div>
      <div className="mt-1.5 flex items-center justify-end gap-3 px-1 text-[11px] text-ink-subtle opacity-0 transition-opacity duration-150 group-focus-within/prompt:opacity-100">
        <span>
          <kbd className="rounded border border-[#e6e6e3] bg-[#fafaf7] px-1 font-mono text-[10px] text-ink-muted">
            ↵
          </kbd>{" "}
          start
        </span>
        <span>
          <kbd className="rounded border border-[#e6e6e3] bg-[#fafaf7] px-1 font-mono text-[10px] text-ink-muted">
            ⇧↵
          </kbd>{" "}
          new line
        </span>
      </div>
    </form>
  );
}

export default function MainPanel({ agents: initialAgents }: { agents: AgentOption[] }) {
  const { workspaceId } = useWorkspaceContext();
  const queryClient = useQueryClient();
  const cachedAgents = queryClient.getQueryData<AgentListItemPayload[]>(
    agentQueryKeys.list(workspaceId),
  );
  const { data: agents = cachedAgents } = useQuery({
    queryKey: agentQueryKeys.list(workspaceId),
    queryFn: fetchAgents,
    staleTime: AGENTS_QUERY_STALE_TIME_MS,
  });
  const agentOptions =
    agents?.map((agent) => ({ id: agent.id, name: agent.name })) ?? initialAgents;

  return (
    <main className="relative flex h-full flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-[680px]">
        <Prompt agents={agentOptions} />
      </div>
    </main>
  );
}
