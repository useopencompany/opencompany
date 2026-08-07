"use client";

import { Button } from "@opencompany/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { toast } from "@opencompany/ui/components/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@opencompany/ui/components/tooltip";
import { Check, Copy, Link2, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChatShareAction,
  getChatShareAction,
  revokeChatShareAction,
} from "@/lib/chat-actions";

type ShareStatus = "idle" | "loading" | "ready" | "error";
type ShareOperation = "copying" | "revoking" | null;
type ChatShareSubject = "chat" | "task run" | "Codex chat" | "Claude Code chat";

export function ChatShareButton({
  chatSessionId,
  disabled = false,
  subject = "chat",
}: {
  chatSessionId: string;
  disabled?: boolean;
  subject?: ChatShareSubject;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ShareStatus>("idle");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [operation, setOperation] = useState<ShareOperation>(null);
  const [shareId, setShareId] = useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [copied, setCopied] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shareUrl = useMemo(() => {
    if (!shareId || typeof window === "undefined") return "";
    return new URL(`/share/${encodeURIComponent(shareId)}`, window.location.origin).toString();
  }, [shareId]);

  useEffect(() => {
    if (!open) return;

    let active = true;

    void getChatShareAction(chatSessionId)
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          setStatus("error");
          return;
        }
        setShareId(result.shareId);
        setStatus("ready");
      })
      .catch(() => {
        if (active) setStatus("error");
      });

    return () => {
      active = false;
    };
  }, [chatSessionId, loadAttempt, open]);

  useEffect(
    () => () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    },
    [],
  );

  function openSharingDialog() {
    if (disabled) return;
    setStatus("loading");
    setOperation(null);
    setConfirmingRevoke(false);
    setCopied(false);
    setOpen(true);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && operation) return;
    setOpen(nextOpen);
    if (!nextOpen) {
      setConfirmingRevoke(false);
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    }
  }

  async function copyShareLink() {
    if (operation) return;
    setOperation("copying");

    try {
      let currentShareId = shareId;
      if (!currentShareId) {
        const result = await createChatShareAction(chatSessionId);
        if (!result.ok) throw new Error(result.error);
        currentShareId = result.shareId;
        setShareId(currentShareId);
      }

      const url = new URL(
        `/share/${encodeURIComponent(currentShareId)}`,
        window.location.origin,
      ).toString();
      if (!navigator.clipboard?.writeText) {
        toast.error("Link created, but your browser could not copy it.");
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Read-only link copied", {
        description: `Anyone with the link can view this ${subject}, including new messages.`,
      });
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => setCopied(false), 1_500);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not copy the chat link.");
    } finally {
      setOperation(null);
    }
  }

  async function stopSharing() {
    if (operation) return;
    setOperation("revoking");

    try {
      const result = await revokeChatShareAction(chatSessionId);
      if (!result.ok) throw new Error(result.error);
      setShareId(null);
      setConfirmingRevoke(false);
      setCopied(false);
      toast.success(`${capitalizeShareSubject(subject)} is no longer shared`, {
        description: "The old link no longer works.",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not stop sharing that chat.");
    } finally {
      setOperation(null);
    }
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          ref={triggerRef}
          type="button"
          aria-label={`Share ${subject}`}
          disabled={disabled}
          onClick={openSharingDialog}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Link2 size={14} strokeWidth={1.9} />
        </TooltipTrigger>
        <TooltipContent>Share {subject}</TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-[420px] gap-5" showCloseButton={operation === null}>
          {confirmingRevoke ? (
            <>
              <DialogHeader className="text-left">
                <DialogTitle className="text-[15px]">Stop sharing this {subject}?</DialogTitle>
                <DialogDescription className="text-[12.5px] leading-5 text-ink-subtle">
                  The current link will stop working immediately. You can create a new link whenever
                  you need one.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={operation === "revoking"}
                  onClick={() => setConfirmingRevoke(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={operation === "revoking"}
                  onClick={stopSharing}
                >
                  {operation === "revoking" ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : null}
                  Stop sharing
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader className="text-left">
                <DialogTitle className="text-[15px]">
                  {status === "ready" && shareId
                    ? `${capitalizeShareSubject(subject)} is shared`
                    : `Share this ${subject}`}
                </DialogTitle>
                <DialogDescription className="text-[12.5px] leading-5 text-ink-subtle">
                  Anyone with the link can view this read-only {subject}, including new messages.
                  They can’t edit or continue it.
                </DialogDescription>
              </DialogHeader>

              {status === "loading" || status === "idle" ? (
                <div
                  role="status"
                  className="flex min-h-20 items-center justify-center text-ink-subtle"
                >
                  <LoaderCircle size={18} strokeWidth={1.8} className="animate-spin" />
                  <span className="sr-only">Loading sharing settings</span>
                </div>
              ) : status === "error" ? (
                <div className="rounded-lg border border-border bg-surface px-4 py-3">
                  <p className="text-[12.5px] leading-5 text-ink-muted">
                    Sharing settings couldn’t be loaded.
                  </p>
                  <button
                    type="button"
                    className="mt-1 text-[12.5px] font-medium text-ink underline underline-offset-4"
                    onClick={() => {
                      setStatus("loading");
                      setLoadAttempt((attempt) => attempt + 1);
                    }}
                  >
                    Try again
                  </button>
                </div>
              ) : shareId ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-surface p-1.5 pl-3">
                    <input
                      readOnly
                      aria-label={`Read-only ${subject} link`}
                      value={shareUrl}
                      onFocus={(event) => event.currentTarget.select()}
                      className="min-w-0 flex-1 bg-transparent text-[12px] text-ink-muted outline-none"
                    />
                    <Button
                      size="sm"
                      disabled={operation === "copying"}
                      onClick={copyShareLink}
                      aria-label={copied ? "Link copied" : "Copy link"}
                    >
                      {operation === "copying" ? (
                        <LoaderCircle className="animate-spin" aria-hidden="true" />
                      ) : copied ? (
                        <Check aria-hidden="true" />
                      ) : (
                        <Copy aria-hidden="true" />
                      )}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                  <button
                    type="button"
                    disabled={operation !== null}
                    onClick={() => setConfirmingRevoke(true)}
                    className="text-[12.5px] font-medium text-destructive transition-opacity hover:opacity-75 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Stop sharing
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={operation === "copying"}
                    onClick={() => handleOpenChange(false)}
                  >
                    Cancel
                  </Button>
                  <Button size="sm" disabled={operation === "copying"} onClick={copyShareLink}>
                    {operation === "copying" ? (
                      <LoaderCircle className="animate-spin" aria-hidden="true" />
                    ) : (
                      <Link2 aria-hidden="true" />
                    )}
                    Create &amp; copy link
                  </Button>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function capitalizeShareSubject(subject: ChatShareSubject) {
  return subject.charAt(0).toUpperCase() + subject.slice(1);
}
