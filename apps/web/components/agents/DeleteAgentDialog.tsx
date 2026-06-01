"use client";

import { Loader2, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";

type Props = {
  agentName: string;
  isOpen: boolean;
  isPending: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

export function DeleteAgentDialog({ agentName, isOpen, isPending, onClose, onConfirm }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const frame = window.requestAnimationFrame(() => {
      cancelRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // Don't close while delete is in-flight — user thinks Escape cancelled
        // but the server action continues regardless.
        if (isPending) return;
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, isPending, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/35 px-4 py-6"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isPending) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-agent-title"
        className="w-full max-w-[420px] rounded-lg border border-black/[0.1] bg-surface-raised shadow-[0_24px_64px_rgba(0,0,0,0.22),0_4px_14px_rgba(0,0,0,0.12)]"
      >
        <div className="border-b border-black/[0.08] px-4 py-3">
          <h2 id="delete-agent-title" className="text-[14px] font-semibold text-ink">
            Delete agent
          </h2>
        </div>
        <div className="px-4 py-4">
          <p className="text-[13px] leading-5 text-ink-muted">
            Are you sure you want to delete{" "}
            <span className="font-medium text-ink">{agentName}</span>? This will permanently delete
            the agent and all its sessions. This action cannot be undone.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-black/[0.08] px-4 py-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="inline-flex h-8 items-center rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-65"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-danger-border bg-danger-bg px-3 text-[12.5px] font-medium text-danger hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-65"
          >
            {isPending ? (
              <Loader2 size={13} strokeWidth={1.9} className="animate-spin" />
            ) : (
              <Trash2 size={13} strokeWidth={1.9} />
            )}
            {isPending ? "Deleting…" : "Delete agent"}
          </button>
        </div>
      </div>
    </div>
  );
}
