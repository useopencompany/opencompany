import type { ChatState } from "@opencompany/core/chat-ui";
import { cn } from "@opencompany/ui/lib/utils";
import { CheckCircle2, LoaderCircle } from "lucide-react";

type ChatStateIndicatorProps = {
  state: ChatState;
  surface: "home" | "sidebar";
  showSeen?: boolean;
  className?: string;
};

export function ChatStateIndicator({
  state,
  surface,
  showSeen = false,
  className,
}: ChatStateIndicatorProps) {
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
