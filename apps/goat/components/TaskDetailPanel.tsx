"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { Square, Workflow as WorkflowIcon } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { ThinkingIndicator } from "@/components/chat/ThinkingIndicator";
import { ArtifactCard } from "@/components/TaskHarnessRunView";
import { TaskRunLiveProvider } from "@/components/TaskRunPanel";
import { goatHarnessRunToChatMessages } from "@/lib/task-chat-messages";
import type { GoatHarnessRunViewModel } from "@/lib/task-harness-run";
import { cancelGoatTaskAction } from "@/lib/tasks";

export function TaskDetailPanel({ initialRun }: { initialRun: GoatHarnessRunViewModel }) {
  return (
    <TaskRunLiveProvider initialRun={initialRun}>
      {(run) => <TaskDetailContent run={run} />}
    </TaskRunLiveProvider>
  );
}

function TaskDetailContent({ run }: { run: GoatHarnessRunViewModel }) {
  const task = run.task;
  const isActive = task.status === "queued" || task.status === "running";
  const messages = useMemo(() => goatHarnessRunToChatMessages(run), [run]);
  const emptyTaskLookup = useMemo(() => new Map(), []);

  return (
    <>
      <header className="flex items-center justify-between gap-3">
        <WorkflowTag workflowId={task.workflowId} name={task.name} />
        {isActive ? <StopTaskButton taskId={task.id} /> : null}
      </header>

      {/* The task transcript reuses the exact main-chat message rendering. */}
      <div className="flex w-full flex-col gap-3">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} taskLookup={emptyTaskLookup} readOnly />
        ))}
        {isActive ? (
          <ThinkingIndicator startedAtMs={taskActivityStartedAtMs(run)} label="Working" />
        ) : null}
        {run.resultArtifact ? <ArtifactCard artifact={run.resultArtifact} /> : null}
      </div>
    </>
  );
}

function taskActivityStartedAtMs(run: GoatHarnessRunViewModel) {
  const parsed = Date.parse(run.task.updatedAt || run.task.createdAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

// Where a chat shows its title, a workflow task shows the workflow it was fired
// from as a `#slug` tag — mirroring the composer mention chip.
function WorkflowTag({ workflowId, name }: { workflowId: string | null; name: string }) {
  if (!workflowId) {
    return (
      <h1 className="min-w-0 flex-1 text-[22px] font-semibold leading-tight tracking-normal text-ink">
        {name}
      </h1>
    );
  }

  return (
    <span
      title={name}
      className="inline-flex items-center gap-1.5 rounded-md bg-ink/10 px-2.5 py-1.5 text-[15px] font-medium leading-none text-ink shadow-[0_0_0_3px_rgba(15,15,15,0.08)]"
    >
      <WorkflowIcon size={15} strokeWidth={2} className="shrink-0 text-ink-subtle" />#{workflowId}
    </span>
  );
}

function StopTaskButton({ taskId }: { taskId: string }) {
  const [isPending, startTransition] = useTransition();
  const [stopRequested, setStopRequested] = useState(false);
  const disabled = isPending || stopRequested;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        setStopRequested(true);
        startTransition(async () => {
          try {
            const result = await cancelGoatTaskAction(taskId);
            if (result.ok) return;
            setStopRequested(false);
            toast.error(result.error ?? "Could not stop task.");
          } catch {
            setStopRequested(false);
            toast.error("Could not stop task.");
          }
        });
      }}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] font-medium text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <Square size={12} strokeWidth={2} />
      {disabled ? "Stopping" : "Stop"}
    </button>
  );
}
