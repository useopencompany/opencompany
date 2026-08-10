"use client";

import type { GoatChatAttachmentKind } from "@opencompany/db/goat-schema";
import { cn } from "@opencompany/ui/lib/utils";
import { FileText, Upload, X } from "lucide-react";

export type PendingGoatChatAttachment = {
  id: string;
  filename: string;
  mediaType: string;
  kind: GoatChatAttachmentKind;
  sizeBytes: number;
  status: "uploading" | "ready" | "error";
  previewUrl?: string;
  blobPathname?: string;
  blobUrl?: string;
  error?: string;
};

// "Drop files to attach" overlay shown over the composer while a file drag is
// active. Adapted from the original composer overlay.
export function GoatComposerDropOverlay({ className }: { className?: string }) {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center"
      aria-hidden="true"
    >
      <div
        className={cn(
          "flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-ink-subtle bg-canvas/85 px-8 py-6 backdrop-blur-sm",
          className,
        )}
      >
        <Upload size={22} strokeWidth={1.6} className="text-ink-muted" />
        <p className="text-[13px] font-medium text-ink">Drop files to attach</p>
        <p className="text-[11.5px] text-ink-subtle">
          PDF, Word, Excel, CSV, text &amp; images · or paste with ⌘V
        </p>
      </div>
    </div>
  );
}

// Short type label shown under the filename. Prefer the extension since it's
// the most recognizable; fall back to the kind.
function attachmentTypeLabel(kind: GoatChatAttachmentKind, filename: string): string {
  const ext = filename.includes(".") ? filename.split(".").pop()?.toUpperCase() : undefined;
  if (ext && ext.length <= 5) return ext;
  if (kind === "image") return "Image";
  if (kind === "pdf") return "PDF";
  if (kind === "docx") return "Word";
  if (kind === "xlsx") return "Excel";
  if (kind === "csv") return "CSV";
  if (kind === "tsv") return "TSV";
  if (kind === "json") return "JSON";
  if (kind === "text") return "Text";
  return "Subtitles";
}

// One compact attachment card — used in the composer (remove button + upload
// status) and on sent user messages (optionally wrapped in a link).
export function GoatChatAttachmentCard({
  kind,
  filename,
  src,
  status,
  error,
  onRemove,
}: {
  kind: GoatChatAttachmentKind;
  filename: string;
  /** Thumbnail source for images (object URL in the composer, served URL in the thread). */
  src?: string | undefined;
  status?: "uploading" | "ready" | "error" | undefined;
  error?: string | undefined;
  onRemove?: (() => void) | undefined;
}) {
  const subtitle =
    status === "uploading"
      ? "Uploading…"
      : status === "error"
        ? (error ?? "Upload failed")
        : attachmentTypeLabel(kind, filename);

  return (
    <div className="group/att relative flex w-[200px] items-center gap-2.5 rounded-xl border border-border bg-surface px-2.5 py-2">
      {kind === "image" && src ? (
        // eslint-disable-next-line @next/next/no-img-element -- thumbnail of a blob:/served URL; next/image can't optimize these.
        <img src={src} alt={filename} className="h-9 w-9 shrink-0 rounded-md object-cover" />
      ) : (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink-muted">
          <FileText size={16} strokeWidth={1.75} />
        </div>
      )}
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate text-[12.5px] font-medium text-ink">{filename}</div>
        <div className={`text-[11px] ${status === "error" ? "text-warning" : "text-ink-subtle"}`}>
          {subtitle}
        </div>
      </div>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${filename}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemove();
          }}
          className="-mr-0.5 shrink-0 rounded p-0.5 text-ink-muted transition-opacity hover:text-ink sm:opacity-0 sm:group-hover/att:opacity-100"
        >
          <X size={14} strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}

export function GoatComposerAttachments({
  attachments,
  onRemove,
}: {
  attachments: PendingGoatChatAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2">
      {attachments.map((att) => (
        <GoatChatAttachmentCard
          key={att.id}
          kind={att.kind}
          filename={att.filename}
          src={att.previewUrl}
          status={att.status}
          error={att.error}
          onRemove={() => onRemove(att.id)}
        />
      ))}
    </div>
  );
}
