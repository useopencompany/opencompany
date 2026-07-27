"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@opencompany/ui/components/tooltip";
import { Check, Link2, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createGoatChatShareAction } from "@/lib/chat-actions";

export function ChatShareButton({
  chatSessionId,
  disabled = false,
}: {
  chatSessionId: string;
  disabled?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "creating" | "copied">("idle");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    },
    [],
  );

  async function copyShareLink() {
    if (disabled || status === "creating") return;
    setStatus("creating");
    try {
      const result = await createGoatChatShareAction(chatSessionId);
      if (!result.ok) throw new Error(result.error);

      const url = new URL(`/share/${encodeURIComponent(result.shareId)}`, window.location.origin);
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(url.toString());
      setStatus("copied");
      toast.success("Read-only link copied", {
        description: "Anyone with the link can view this chat, including new messages.",
      });
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => setStatus("idle"), 1_500);
    } catch (error) {
      setStatus("idle");
      toast.error(error instanceof Error ? error.message : "Could not copy the chat link.");
    }
  }

  const copied = status === "copied";
  const label = copied ? "Read-only link copied" : "Copy read-only link";

  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        aria-label={label}
        disabled={disabled || status === "creating"}
        onClick={copyShareLink}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === "creating" ? (
          <LoaderCircle size={14} strokeWidth={1.9} className="animate-spin" />
        ) : copied ? (
          <Check size={14} strokeWidth={2} />
        ) : (
          <Link2 size={14} strokeWidth={1.9} />
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
