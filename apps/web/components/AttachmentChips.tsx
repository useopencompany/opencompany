"use client";

import type { MessagePastedAttachmentMeta } from "@opencompany/db/schema";
import { FileText, GripVertical, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { PromptAttachment } from "@/components/usePromptAttachments";
import { cn } from "@/lib/utils";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function chipMeta(bytes: number, lineCount: number) {
  const lines = `${lineCount.toLocaleString()} ${lineCount === 1 ? "line" : "lines"}`;
  return `${lines} · ${formatBytes(bytes)}`;
}

// Shared chip chrome: a small file-like pill with an icon, label, and size summary.
function ChipShell({
  label,
  meta,
  leading,
  trailing,
  onClick,
  className,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  label: string;
  meta: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  onClick?: () => void;
  className?: string;
  draggable?: boolean;
  onDragStart?: (event: React.DragEvent) => void;
  onDragOver?: (event: React.DragEvent) => void;
  onDrop?: (event: React.DragEvent) => void;
  onDragEnd?: () => void;
}) {
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={cn(
        "flex max-w-[240px] items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1.5",
        className,
      )}
    >
      {leading}
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink-muted">
        <FileText size={14} strokeWidth={1.75} />
      </span>
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        className={cn(
          "min-w-0 flex-1 text-left",
          onClick ? "cursor-pointer" : "cursor-default",
        )}
      >
        <span className="block truncate text-[12.5px] leading-tight text-ink">{label}</span>
        <span className="block truncate text-[11px] leading-tight text-ink-subtle">{meta}</span>
      </button>
      {trailing}
    </div>
  );
}

// Editable chip row for the composer: drag-to-reorder, click-to-preview, remove.
export function PromptAttachmentChips({
  attachments,
  onRemove,
  onReorder,
}: {
  attachments: PromptAttachment[];
  onRemove: (id: string) => void;
  onReorder: (fromId: string, toId: string) => void;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const preview = attachments.find((attachment) => attachment.id === previewId) ?? null;

  if (attachments.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-1.5 px-1 pb-1" role="list" aria-label="Attachments">
        {attachments.map((attachment) => (
          <div key={attachment.id} role="listitem">
            <ChipShell
              label={attachment.label}
              meta={chipMeta(attachment.bytes, attachment.lineCount)}
              draggable
              onDragStart={(event) => {
                setDraggingId(attachment.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", attachment.id);
              }}
              onDragOver={(event) => {
                if (draggingId && draggingId !== attachment.id) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const fromId = draggingId ?? event.dataTransfer.getData("text/plain");
                if (fromId) onReorder(fromId, attachment.id);
                setDraggingId(null);
              }}
              onDragEnd={() => setDraggingId(null)}
              onClick={() => setPreviewId(attachment.id)}
              className={cn(draggingId === attachment.id && "opacity-50")}
              leading={
                <span className="shrink-0 cursor-grab text-ink-subtle active:cursor-grabbing">
                  <GripVertical size={13} strokeWidth={1.75} />
                </span>
              }
              trailing={
                <button
                  type="button"
                  onClick={() => onRemove(attachment.id)}
                  aria-label={`Remove attachment ${attachment.label}`}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-subtle hover:bg-surface-hover hover:text-ink"
                >
                  <X size={13} strokeWidth={2} />
                </button>
              }
            />
          </div>
        ))}
      </div>
      <div aria-live="polite" className="sr-only">
        {attachments.length === 1
          ? "1 attachment"
          : `${attachments.length} attachments`}
      </div>
      {preview ? (
        <AttachmentPreview
          label={preview.label}
          meta={chipMeta(preview.bytes, preview.lineCount)}
          content={preview.content}
          onClose={() => setPreviewId(null)}
        />
      ) : null}
    </>
  );
}

// Read-only chip row shown on sent user messages. The full content lives server-side only,
// so these are display-only (no preview/remove).
export function MessageAttachmentChips({
  attachments,
}: {
  attachments: MessagePastedAttachmentMeta[];
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" role="list" aria-label="Attachments">
      {attachments.map((attachment) => (
        <div key={attachment.id} role="listitem">
          <ChipShell
            label={attachment.label}
            meta={chipMeta(attachment.bytes, attachment.lineCount)}
          />
        </div>
      ))}
    </div>
  );
}

function AttachmentPreview({
  label,
  meta,
  content,
  onClose,
}: {
  label: string;
  meta: string;
  content: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Attachment preview: ${label}`}
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-ink">{label}</p>
            <p className="truncate text-[11px] text-ink-subtle">{meta}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-surface-hover hover:text-ink"
          >
            <X size={15} strokeWidth={2} />
          </button>
        </div>
        <pre className="overflow-auto whitespace-pre-wrap break-words px-4 py-3 text-[12.5px] leading-5 text-ink">
          {content}
        </pre>
      </div>
    </div>
  );
}
