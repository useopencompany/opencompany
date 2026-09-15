"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@opencompany/ui/components/tooltip";
import { CornerDownLeft, CornerDownRight, Trash2 } from "lucide-react";
import { useState } from "react";
import type { QueuedChatMessage } from "./queued-messages";

// A message waiting behind the turn that is still running. Sending it again is not the user's
// problem to solve: they can leave it queued, push it into the live turn ("Steer") so the engine
// course-corrects without losing the work it has already done, or drop it.

export function QueuedMessageCard({
  message,
  onSteer,
  onRemove,
}: {
  message: QueuedChatMessage;
  onSteer: () => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [pendingAction, setPendingAction] = useState<"steer" | "remove" | null>(null);

  const runAction = (action: "steer" | "remove", perform: () => Promise<void>) => {
    if (pendingAction) return;
    setPendingAction(action);
    // The card unmounts when the Run leaves the queue, so the pending flag is only ever cleared
    // here for an action that failed and left the message queued.
    void perform().catch(() => setPendingAction(null));
  };

  return (
    <div
      data-testid="chat-queued-message"
      className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
    >
      <CornerDownLeft size={13} strokeWidth={1.8} className="shrink-0 text-ink-subtle" />
      <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-ink">{message.text}</span>
      <Tooltip>
        <TooltipTrigger
          type="button"
          disabled={pendingAction !== null}
          onClick={() => runAction("steer", onSteer)}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[12px] leading-4 text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-50"
        >
          <CornerDownRight size={13} strokeWidth={1.8} />
          {pendingAction === "steer" ? "Steering…" : "Steer"}
        </TooltipTrigger>
        <TooltipContent>Send this into the turn that is running now</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          type="button"
          aria-label="Remove queued message"
          disabled={pendingAction !== null}
          onClick={() => runAction("remove", onRemove)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-50"
        >
          <Trash2 size={13} strokeWidth={1.8} />
        </TooltipTrigger>
        <TooltipContent>Remove queued message</TooltipContent>
      </Tooltip>
    </div>
  );
}
