"use client";

import type { AgentConfig, AgentModelId, TiptapDoc } from "@opencompany/agent-runtime/types";
import { useQuery } from "@tanstack/react-query";
import { Check, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { AgentEditorWithAddSkillDialog } from "@/components/agent-editor/AgentEditorWithAddSkillDialog";
import { ModelPicker } from "@/components/agent-editor/ModelPicker";
import { mergeSkillCatalog } from "@/components/agent-editor/skillCatalog";
import { buildAgentMentionItems, findModel } from "@/components/agent-editor/tools";
import { PersonalAgentAvatar } from "@/components/personal/PersonalAgentAvatar";
import { usePersonalAgent } from "@/components/personal/PersonalAgentContext";
import { useToast } from "@/components/ToastProvider";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { updatePersonalAgentBehavior } from "@/lib/personal/actions";
import { fetchWorkspaceSkills } from "@/lib/skills/client";

type SaveState = "idle" | "saving" | "saved";

const DEFAULT_MODEL_ID: AgentModelId = "moonshotai/kimi-k2.6";

// The behavior surface = the agent's editable `.agent` body. We reuse the shared Tiptap
// AgentEditor (same one the full agent inspector uses) so @-mentioning a tool, skill, or
// repository here flows straight into the agent config the rest of the sidebar reflects.
export function PersonalBehaviorEditor({
  agentId,
  initialBody,
  initialContent,
  config,
  onConfigChange,
  onDraftChange,
}: {
  agentId: string;
  initialBody: string;
  initialContent: TiptapDoc;
  config: AgentConfig;
  onConfigChange: (config: AgentConfig) => void;
  // Bubble every keystroke up so the parent (which outlives this component across panel
  // switches) can reseed the editor with the live draft instead of stale server props.
  onDraftChange: (body: string, content: TiptapDoc) => void;
}) {
  const { workspaceId } = useWorkspaceContext();
  const { agent, githubRepositories } = usePersonalAgent();
  const { showError } = useToast();
  const { data: workspaceSkills } = useQuery({
    queryKey: ["workspace-skills", workspaceId],
    queryFn: fetchWorkspaceSkills,
  });
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [, startTransition] = useTransition();
  const [selectedModelId, setSelectedModelId] = useState<AgentModelId>(
    () => findModel(config.model.name)?.id ?? DEFAULT_MODEL_ID,
  );
  const pendingRef = useRef<{ body: string; content: TiptapDoc; model?: AgentModelId } | null>(
    null,
  );
  // Latest editor body/content, whether or not a save is pending. A model-only change still has
  // to send body+content (the action re-derives config from the body), so it reads from here.
  const latestRef = useRef<{ body: string; content: TiptapDoc }>({
    body: initialBody,
    content: initialContent,
  });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // External skills the agent already references stay mentionable; everything else
  // (built-in tools, the GitHub integration) comes from the default catalog. Repositories come
  // from the workspace GitHub integration's catalog (mirrors AgentDetail), so the user can
  // @-mention any repo the connection can reach — not only repos already saved on the config.
  const mentionItems = useMemo(() => {
    const skills = mergeSkillCatalog(config.skills ?? [], workspaceSkills ?? []);
    return buildAgentMentionItems(githubRepositories, [], { skills });
  }, [githubRepositories, config.skills, workspaceSkills]);

  // The actual persist. `interactive` debounced saves drive the local save indicator; the
  // final flush on unmount runs fire-and-forget (this component is gone, so it must not touch
  // local state — but onConfigChange targets the still-mounted parent, so it stays safe).
  // Held in a ref so the unmount effect can call the latest version without re-subscribing.
  const persistRef = useRef<
    | ((
        patch: { body: string; content: TiptapDoc; model?: AgentModelId },
        interactive: boolean,
      ) => Promise<void>)
    | null
  >(null);

  useEffect(() => {
    persistRef.current = async (patch, interactive) => {
      try {
        const result = await updatePersonalAgentBehavior(agentId, patch);
        if (!result.ok) {
          if (interactive) {
            setSaveState("idle");
            showError(result.error, "Could not save behavior");
          }
          return;
        }
        onConfigChange(result.config);
        if (interactive) setSaveState("saved");
      } catch (error) {
        if (interactive) {
          setSaveState("idle");
          showError(
            error instanceof Error ? error.message : "Could not save behavior",
            "Could not save behavior",
          );
        }
      }
    };
  }, [agentId, onConfigChange, showError]);

  const flush = () => {
    const patch = pendingRef.current;
    if (!patch) return;
    pendingRef.current = null;
    setSaveState("saving");
    startTransition(async () => {
      await persistRef.current?.(patch, true);
    });
  };

  const schedule = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, 600);
  };

  // On unmount (e.g. switching to another /personal panel) flush any still-debounced edit so
  // the pending DB write is never silently dropped on the way out.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const patch = pendingRef.current;
      pendingRef.current = null;
      if (patch) void persistRef.current?.(patch, false);
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-[680px] px-6 py-10">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <PersonalAgentAvatar name={agent.name} size={34} />
          <div>
            <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">{agent.name}</h1>
            <div className="mt-1 -ml-1.5 flex items-center">
              <ModelPicker
                value={selectedModelId}
                fallbackModelId={DEFAULT_MODEL_ID}
                aria-label="Default model"
                onChange={(modelId) => {
                  setSelectedModelId(modelId);
                  // A model-only change still needs body+content on the wire — the server action
                  // re-derives the whole config from the body on every save.
                  pendingRef.current = {
                    body: pendingRef.current?.body ?? latestRef.current.body,
                    content: pendingRef.current?.content ?? latestRef.current.content,
                    model: modelId,
                  };
                  schedule();
                }}
              />
            </div>
          </div>
        </div>
        <SaveIndicator state={saveState} />
      </div>

      <div className="mt-6">
        <AgentEditorWithAddSkillDialog
          key={agentId}
          initialBody={initialBody}
          initialContent={initialContent}
          mentionItems={mentionItems}
          onChange={(body, content) => {
            const doc = content as TiptapDoc;
            latestRef.current = { body, content: doc };
            // Keep a not-yet-flushed model change instead of clobbering it with a body edit.
            pendingRef.current = { ...pendingRef.current, body, content: doc };
            onDraftChange(body, doc);
            schedule();
          }}
        />
      </div>
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === "saving") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-subtle">
        <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />
        Saving…
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-subtle">
        <Check size={12} strokeWidth={2} />
        Saved
      </span>
    );
  }
  return null;
}
