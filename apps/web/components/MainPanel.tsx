"use client";

import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { useLiveQuery } from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ModelPicker } from "@/components/agent-editor/ModelPicker";
import { useCollections } from "@/components/CollectionsProvider";
import { Composer } from "@/components/Composer";
import { useToast } from "@/components/ToastProvider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHydrated } from "@/components/useHydrated";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { createAgentSessionFromPrompt } from "@/lib/agent-sessions/actions";
import { seedSessionQueries } from "@/lib/agent-sessions/payload";
import { agentRowToListItem, sortAgentsByUpdatedDesc } from "@/lib/collections/selectors";

const TEXTAREA_MAX_HEIGHT_PX = 220;
const DEFAULT_MODEL_ID: AgentModelId = "openai/gpt-5.4-mini";

type AgentOption = {
  id: string;
  name: string;
  // The agent's saved default model. The composer's model selector starts here and
  // re-syncs to it whenever the selected agent changes.
  defaultModel: string;
};

function Prompt({ agents }: { agents: AgentOption[] }) {
  const { workspaceId } = useWorkspaceContext();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { showToast } = useToast();
  const [input, setInput] = useState("");
  const [selectedAgentIdOverride, setSelectedAgentIdOverride] = useState("");
  // An explicit model pick, scoped to the agent it was made for. Scoping it this way means a
  // pick for agent A doesn't carry over when you switch to agent B — the selector falls back to
  // B's default — without a state-resetting effect.
  const [modelOverride, setModelOverride] = useState<{ agentId: string; modelId: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectedAgentId = selectedAgentIdOverride || agents.at(0)?.id || "";
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents.at(0);
  // The model used for the new session: an explicit pick for THIS agent wins, otherwise the
  // selected agent's saved default. Picking a model here never changes the agent's default.
  const selectedModel =
    (modelOverride?.agentId === selectedAgentId ? modelOverride.modelId : null) ??
    selectedAgent?.defaultModel ??
    "";
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
      const result = await createAgentSessionFromPrompt(
        selectedAgentId,
        content,
        selectedModel || undefined,
      );
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
    >
      <Composer
        variant="expanded"
        error={error}
        input={
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
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
            className="min-h-9 w-full resize-none content-center bg-transparent text-[15px] leading-6 tracking-[-0.005em] text-ink placeholder:text-ink-subtle outline-none"
            style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
          />
        }
        leftControls={
          <>
            <Select
              disabled={agents.length === 0}
              value={selectedAgentId}
              onValueChange={setSelectedAgentIdOverride}
            >
              <SelectTrigger
                aria-label="Agent"
                className="h-7 w-auto max-w-[240px] border-transparent bg-transparent py-1 pl-1.5 pr-2 text-[12.5px] text-ink/90 shadow-none hover:bg-surface-hover focus:ring-1 focus:ring-ink/20 data-[placeholder]:text-ink-subtle"
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
            {selectedModel ? (
              <ModelPicker
                value={selectedModel}
                fallbackModelId={DEFAULT_MODEL_ID}
                onChange={(modelId) => setModelOverride({ agentId: selectedAgentId, modelId })}
              />
            ) : null}
          </>
        }
        action={
          <button
            type="submit"
            disabled={!canSubmit}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={isPending ? "Starting session…" : "Start session"}
          >
            {isPending ? (
              <LoaderCircle size={13} strokeWidth={2} className="animate-spin" />
            ) : (
              <ArrowUp size={13} strokeWidth={2} />
            )}
          </button>
        }
        rightControls={
          <div className="hidden items-center gap-3 px-1 text-[11px] text-ink-subtle opacity-0 transition-opacity duration-150 group-focus-within/composer:opacity-100 sm:flex">
            <span>
              <kbd className="rounded border border-border bg-surface-muted px-1 font-mono text-[10px] text-ink-muted">
                ↵
              </kbd>{" "}
              start
            </span>
            <span>
              <kbd className="rounded border border-border bg-surface-muted px-1 font-mono text-[10px] text-ink-muted">
                ⇧↵
              </kbd>{" "}
              new line
            </span>
          </div>
        }
      />
    </form>
  );
}

function MainPanelContent({ agents, slackCard }: { agents: AgentOption[]; slackCard?: ReactNode }) {
  return (
    <div className="flex h-full min-w-0 flex-1 bg-sidebar">
      <main className="relative my-2 mr-2 flex min-w-0 flex-1 flex-col items-center justify-center overflow-y-auto rounded-xl border border-border bg-canvas px-6 py-10 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        <div className="w-full max-w-[680px]">
          <Prompt agents={agents} />
          {slackCard}
        </div>
      </main>
    </div>
  );
}

// Client-only: gated behind useHydrated in the default export because
// useLiveQuery cannot render during SSR.
function MainPanelLive({
  initialAgents,
  slackCard,
}: {
  initialAgents: AgentOption[];
  slackCard?: ReactNode;
}) {
  const { agents: agentsCollection } = useCollections();
  const { data: rows, isLoading } = useLiveQuery((q) => q.from({ agent: agentsCollection }));
  const agentOptions = useMemo(() => {
    // Fall back to the server-provided picker options until the collection hydrates.
    if (isLoading && initialAgents.length > 0) return initialAgents;
    return sortAgentsByUpdatedDesc((rows ?? []).map(agentRowToListItem)).map((agent) => ({
      id: agent.id,
      name: agent.name,
      defaultModel: agent.config.model.name,
    }));
  }, [isLoading, initialAgents, rows]);

  return <MainPanelContent agents={agentOptions} slackCard={slackCard} />;
}

export default function MainPanel({
  agents: initialAgents,
  slackCard,
}: {
  agents: AgentOption[];
  slackCard?: ReactNode;
}) {
  const hydrated = useHydrated();
  if (!hydrated) return <MainPanelContent agents={initialAgents} slackCard={slackCard} />;
  return <MainPanelLive initialAgents={initialAgents} slackCard={slackCard} />;
}
