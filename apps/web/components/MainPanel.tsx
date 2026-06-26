"use client";

import {
  CODEX_AGENT_MODEL_IDS,
  CODEX_DEFAULT_MODEL_ID,
  isCodexModelId,
} from "@opencompany/agent-runtime";
import type {
  AgentEngine,
  AgentModelId,
  CodexReasoningEffort,
} from "@opencompany/agent-runtime/types";
import { useLiveQuery } from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, LoaderCircle, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ModelPicker } from "@/components/agent-editor/ModelPicker";
import { showOutOfCreditsToast } from "@/components/billing/out-of-credits-toast";
import { useCollections } from "@/components/CollectionsProvider";
import { Composer } from "@/components/Composer";
import {
  ATTACHMENT_FILE_INPUT_ACCEPT,
  ComposerAttachments,
  ComposerDropOverlay,
  toSubmitAttachments,
} from "@/components/composer-attachments";
import { CodexComposerControls } from "@/components/session/CodexComposerControls";
import { useToast } from "@/components/ToastProvider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useComposerAttachments } from "@/components/useComposerAttachments";
import { useHydrated } from "@/components/useHydrated";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { createAgentSessionFromPrompt } from "@/lib/agent-sessions/actions";
import { seedSessionQueries } from "@/lib/agent-sessions/payload";
import { agentRowToListItem, sortAgentsByUpdatedDesc } from "@/lib/collections/selectors";

const TEXTAREA_MAX_HEIGHT_PX = 220;
const DEFAULT_MODEL_ID: AgentModelId = "openai/gpt-5.4-mini";
const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = "high";

type AgentOption = {
  id: string;
  name: string;
  // The agent's saved default model. The composer's model selector starts here and
  // re-syncs to it whenever the selected agent changes.
  defaultModel: string;
  engine: AgentEngine;
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
  const [codexReasoningOverride, setCodexReasoningOverride] = useState<{
    agentId: string;
    reasoningEffort: CodexReasoningEffort;
  } | null>(null);
  const [codexPlanMode, setCodexPlanMode] = useState<{
    agentId: string;
    enabled: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedAgentId = selectedAgentIdOverride || agents.at(0)?.id || "";
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents.at(0);
  const selectedAgentIsCodex = selectedAgent?.engine === "codex";
  const defaultModelForSelectedAgent =
    selectedAgentIsCodex && selectedAgent
      ? isCodexModelId(selectedAgent.defaultModel)
        ? selectedAgent.defaultModel
        : CODEX_DEFAULT_MODEL_ID
      : selectedAgent?.defaultModel;
  // The model used for the new session: an explicit pick for THIS agent wins, otherwise the
  // selected agent's saved default. Picking a model here never changes the agent's default.
  const scopedModelOverride =
    modelOverride?.agentId === selectedAgentId ? modelOverride.modelId : null;
  const selectedModel =
    selectedAgentIsCodex && scopedModelOverride && !isCodexModelId(scopedModelOverride)
      ? CODEX_DEFAULT_MODEL_ID
      : (scopedModelOverride ?? defaultModelForSelectedAgent ?? "");
  const codexReasoningEffort =
    codexReasoningOverride?.agentId === selectedAgentId
      ? codexReasoningOverride.reasoningEffort
      : DEFAULT_CODEX_REASONING_EFFORT;
  const codexPlanModeEnabled =
    selectedAgentIsCodex && codexPlanMode?.agentId === selectedAgentId
      ? codexPlanMode.enabled
      : false;
  // Image/file attachments via the shared composer hook. No session exists yet — uploads land in
  // a sessionless "pending/" path and the pointers ride into createAgentSessionFromPrompt.
  const {
    attachments,
    setAttachments,
    acceptFiles,
    removeAttachment,
    isDragActive,
    isUploading,
    handlePasteFiles,
    dragHandlers,
  } = useComposerAttachments({
    workspaceId,
    modelName: selectedModel,
    uploadScope: { kind: "pending" },
    enabled: true,
  });
  const ready = attachments.filter((a) => a.status === "ready" && a.blobPathname && a.blobUrl);
  const hasUploadError = attachments.some((a) => a.status === "error");
  // Submit needs text OR a ready attachment, and is blocked while any upload is in flight or
  // errored (so an image is never silently dropped, and a broken upload can't be sent).
  const canSubmit = Boolean(
    (input.trim() || ready.length > 0) &&
      selectedAgentId &&
      !isPending &&
      !isUploading &&
      !hasUploadError,
  );

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
    const submitReady = ready;
    if ((!content && submitReady.length === 0) || isPending || isUploading || hasUploadError)
      return;
    if (!selectedAgentId) {
      setError("Create an agent first before starting a session.");
      return;
    }

    setError(null);
    startTransition(async () => {
      const sessionOptions = selectedAgentIsCodex
        ? {
            codexReasoningEffort,
            ...(codexPlanModeEnabled ? { codexPlanModeEnabled: true } : {}),
          }
        : undefined;
      const result = await createAgentSessionFromPrompt(
        selectedAgentId,
        content,
        selectedModel || undefined,
        toSubmitAttachments(submitReady),
        sessionOptions,
      );
      if (!result.ok) {
        if ("redirectTo" in result) {
          showOutOfCreditsToast({
            showToast,
            router,
            redirectTo: result.redirectTo,
            reason: "reason" in result ? String(result.reason) : undefined,
          });
          return;
        }
        setError(result.error);
        return;
      }
      // Sent — the destination session paints the image from the persisted attachment (served via
      // /api/attachments), so the local blob previews aren't needed there: revoke + clear the tray.
      attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
      setAttachments([]);
      setCodexPlanMode(null);
      seedSessionQueries(queryClient, workspaceId, result.detail);
      router.push(`/company/session/${result.session.id}`);
    });
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="relative"
      {...dragHandlers}
    >
      {isDragActive ? <ComposerDropOverlay className="rounded-2xl" /> : null}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ATTACHMENT_FILE_INPUT_ACCEPT}
        className="hidden"
        onChange={(event) => {
          acceptFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <ComposerAttachments attachments={attachments} onRemove={removeAttachment} />
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
              // Files in the clipboard (e.g. a screenshot) attach via the shared hook, which also
              // stops the browser pasting them into the textarea. Text pastes fall through.
              handlePasteFiles(event);
            }}
            rows={1}
            placeholder="Ask Open Company to build, fix bugs, explore"
            className="min-h-9 w-full resize-none content-center bg-transparent text-[16px] md:text-[15px] leading-6 tracking-[-0.005em] text-ink placeholder:text-ink-subtle outline-none"
            style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
          />
        }
        leftControls={
          <>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach file"
              className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-surface-hover hover:text-ink"
            >
              <Plus size={15} strokeWidth={1.75} />
            </button>
            <Select
              disabled={agents.length === 0}
              value={selectedAgentId}
              onValueChange={(agentId) => {
                setSelectedAgentIdOverride(agentId);
                setCodexPlanMode(null);
              }}
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
                fallbackModelId={selectedAgentIsCodex ? CODEX_DEFAULT_MODEL_ID : DEFAULT_MODEL_ID}
                {...(selectedAgentIsCodex ? { modelIds: CODEX_AGENT_MODEL_IDS } : {})}
                onChange={(modelId) => setModelOverride({ agentId: selectedAgentId, modelId })}
              />
            ) : null}
            {selectedAgentIsCodex ? (
              <CodexComposerControls
                reasoningEffort={codexReasoningEffort}
                planModeEnabled={codexPlanModeEnabled}
                onReasoningEffortChange={(reasoningEffort) =>
                  setCodexReasoningOverride({ agentId: selectedAgentId, reasoningEffort })
                }
                onPlanModeEnabledChange={(enabled) =>
                  setCodexPlanMode(enabled ? { agentId: selectedAgentId, enabled } : null)
                }
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
      engine: agent.config.engine,
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
