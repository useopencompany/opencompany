import { cn } from "@opencompany/ui/lib/utils";
import { CheckCircle2, LoaderCircle } from "lucide-react";
import type { ChatState } from "@/lib/chat-ui";

type ChatStateIndicatorProps = {
  state: ChatState;
  surface: "home" | "sidebar";
  showSeen?: boolean;
  className?: string;
};

export const AWAITING_INPUT_LABEL = "Waiting for you";

export function ChatStateIndicator({
  state,
  surface,
  showSeen = false,
  className,
}: ChatStateIndicatorProps) {
  if (state === "awaiting_input") {
    // The only indicator with an accessible name: every other state describes what the agent is
    // doing, this one is a request aimed at the reader, and it is the difference between a run
    // that is progressing and one that is stuck on them.
    return (
      <span
        role="img"
        aria-label={AWAITING_INPUT_LABEL}
        title={AWAITING_INPUT_LABEL}
        data-testid={`${surface}-chat-awaiting-input`}
        className={cn(
          surface === "home" ? "h-2 w-2" : "h-1.5 w-1.5",
          "shrink-0 rounded-full bg-warning",
          className,
        )}
      />
    );
  }

  if (state === "working") {
    return (
      <LoaderCircle
        aria-hidden="true"
        data-testid={`${surface}-chat-working`}
        size={surface === "home" ? 15 : 11}
        strokeWidth={2}
        className={cn("shrink-0 animate-spin text-warning", className)}
      />
    );
  }

  if (state === "done_unseen") {
    return (
      <span
        aria-hidden="true"
        data-testid={`${surface}-chat-unseen`}
        className={cn(
          surface === "home" ? "h-2 w-2" : "h-1.5 w-1.5",
          "shrink-0 rounded-full bg-info",
          className,
        )}
      />
    );
  }

  if (showSeen) {
    return (
      <CheckCircle2
        aria-hidden="true"
        data-testid={`${surface}-chat-seen`}
        size={15}
        strokeWidth={2}
        className={cn("shrink-0 text-success", className)}
      />
    );
  }

  return null;
}
