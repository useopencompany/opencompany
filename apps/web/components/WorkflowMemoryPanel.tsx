"use client";

import type { WorkflowMemoryDto } from "@opencompany/protocol";
import { Button } from "@opencompany/ui/components/button";
import { Switch } from "@opencompany/ui/components/switch";
import { Brain, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Markdown } from "@/components/Markdown";
import {
  clearHeadlessWorkflowMemory,
  setHeadlessWorkflowMemoryEnabled,
} from "@/lib/headless-automation-commands";

// Memory is not part of the workflow's versioned definition, so this panel writes through its own
// endpoints instead of the editor's autosave. Each control commits immediately.
export function WorkflowMemoryPanel({
  workflowId,
  memory,
  canEdit,
}: {
  workflowId: string;
  memory: WorkflowMemoryDto;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState(memory);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // A run can store a whitespace-only note, which is nothing to show and nothing to clear. Deriving
  // both the timestamp line and the Clear action from the visible note keeps those in step.
  const note = state.content.trim();

  const commit = (
    optimistic: WorkflowMemoryDto,
    command: () => Promise<WorkflowMemoryDto>,
    failure: string,
  ) => {
    const previous = state;
    setError(null);
    setState(optimistic);
    startTransition(async () => {
      try {
        setState(await command());
        router.refresh();
      } catch (commandError) {
        setState(previous);
        setError(commandError instanceof Error ? commandError.message : failure);
      }
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex items-start gap-3 px-4 py-3.5">
          <Brain size={16} strokeWidth={1.8} className="mt-0.5 shrink-0 text-ink-subtle" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-medium text-ink">Memory</h2>
            <p className="mt-0.5 text-[12.5px] leading-5 text-ink-subtle">
              Give this workflow one markdown note it can read and rewrite, so every run starts with
              what the last one learned.
            </p>
          </div>
          <Switch
            checked={state.enabled}
            disabled={!canEdit || isPending}
            aria-label={state.enabled ? "Turn off memory" : "Turn on memory"}
            onCheckedChange={(enabled) =>
              commit(
                { ...state, enabled },
                () => setHeadlessWorkflowMemoryEnabled(workflowId, enabled),
                "Memory could not be updated.",
              )
            }
          />
        </div>
        {state.enabled ? (
          <div className="flex flex-col gap-3 border-t border-border px-4 py-3.5">
            <div className="flex min-h-7 items-center justify-between gap-3">
              <span className="text-[12px] text-ink-subtle">
                {note && state.updatedAt
                  ? `Last written ${formatMemoryTimestamp(state.updatedAt)}`
                  : "Nothing remembered yet."}
              </span>
              {canEdit && note ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isPending}
                  onClick={() =>
                    commit(
                      { ...state, content: "", updatedAt: null },
                      () => clearHeadlessWorkflowMemory(workflowId),
                      "Memory could not be cleared.",
                    )
                  }
                >
                  {isPending ? <Loader2 className="animate-spin" /> : null}
                  Clear
                </Button>
              ) : null}
            </div>
            {note ? (
              <div className="max-h-72 overflow-y-auto rounded-lg border border-border bg-canvas px-3 py-2.5">
                <Markdown content={note} />
              </div>
            ) : (
              <p className="text-[12.5px] leading-5 text-ink-subtle">
                Runs can write here with the update memory tool.
              </p>
            )}
          </div>
        ) : null}
      </div>
      {error ? (
        <p className="text-[12px] text-warning" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function formatMemoryTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
