"use client";

import type { AgentConfig, TiptapDoc } from "@opencompany/agent-runtime/types";
import { useQuery } from "@tanstack/react-query";
import { Check, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { AgentEditorWithAddSkillDialog } from "@/components/agent-editor/AgentEditorWithAddSkillDialog";
import { mergeSkillCatalog } from "@/components/agent-editor/skillCatalog";
import { buildAgentMentionItems } from "@/components/agent-editor/tools";
import { useToast } from "@/components/ToastProvider";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { updatePersonalAgentBehavior } from "@/lib/personal/actions";
import { fetchWorkspaceSkills } from "@/lib/skills/client";

type SaveState = "idle" | "saving" | "saved";

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
  const { showError } = useToast();
  const { data: workspaceSkills } = useQuery({
    queryKey: ["workspace-skills", workspaceId],
    queryFn: fetchWorkspaceSkills,
  });
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [, startTransition] = useTransition();
  const pendingRef = useRef<{ body: string; content: TiptapDoc } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // External skills the agent already references stay mentionable; everything else
  // (built-in tools, the GitHub integration) comes from the default catalog.
  const mentionItems = useMemo(() => {
    const repositories = config.integrations.github.repositories.map((repository) => ({
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      ...(repository.binding ? { binding: repository.binding } : {}),
    }));
    const skills = mergeSkillCatalog(config.skills ?? [], workspaceSkills ?? []);
    return buildAgentMentionItems(repositories, [], { skills });
  }, [config.integrations.github.repositories, config.skills, workspaceSkills]);

  // The actual persist. `interactive` debounced saves drive the local save indicator; the
  // final flush on unmount runs fire-and-forget (this component is gone, so it must not touch
  // local state — but onConfigChange targets the still-mounted parent, so it stays safe).
  // Held in a ref so the unmount effect can call the latest version without re-subscribing.
  const persistRef = useRef<
    ((patch: { body: string; content: TiptapDoc }, interactive: boolean) => Promise<void>) | null
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">Behavior</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            Describe how your agent should work. Mention tools, skills, or repositories with @.
          </p>
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
            pendingRef.current = { body, content: doc };
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
