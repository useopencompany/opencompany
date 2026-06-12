"use client";

import type { AttachmentKind } from "@opencompany/agent-runtime";
import { upload } from "@vercel/blob/client";
import { FileText, Upload, X } from "lucide-react";
import { cn } from "@/lib/utils";
// (AttachmentCard is also imported by SessionView for the sent-message thread render.)

export type PendingAttachment = {
  id: string;
  filename: string;
  mediaType: string;
  kind: AttachmentKind;
  sizeBytes: number;
  status: "uploading" | "ready" | "error";
  previewUrl?: string;
  blobPathname?: string;
  blobUrl?: string;
  error?: string;
};

// The "Drop files to attach" overlay shown over a composer's drop zone while a file drag is
// active. Shared by every composer (session + the two home composers) so the copy/icon stay in
// one place; `className` only tweaks the card's border-radius to match each composer's chrome.
export function ComposerDropOverlay({ className }: { className?: string }) {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center"
      aria-hidden="true"
    >
      <div
        className={cn(
          "flex flex-col items-center gap-2 border-2 border-dashed border-ink-subtle bg-canvas/85 px-8 py-6 backdrop-blur-sm",
          className ?? "rounded-lg",
        )}
      >
        <Upload size={22} strokeWidth={1.6} className="text-ink-muted" />
        <p className="text-[13px] font-medium text-ink">Drop files to attach</p>
        <p className="text-[11.5px] text-ink-subtle">
          Images, PDF, text &amp; code · or paste with ⌘V
        </p>
      </div>
    </div>
  );
}

// Map the composer's ready attachments to the server-action attachment payload. Callers pass a
// list already filtered to status==="ready" with blob pointers present (the send gate guarantees
// it), so the non-null assertions hold; centralizing this keeps the shape in one place.
export function toSubmitAttachments(ready: PendingAttachment[]): Array<{
  blobPathname: string;
  blobUrl: string;
  mediaType: string;
  filename: string;
  sizeBytes: number;
}> {
  return ready.map((a) => ({
    // biome-ignore lint/style/noNonNullAssertion: caller filtered to ready attachments with blob fields
    blobPathname: a.blobPathname!,
    // biome-ignore lint/style/noNonNullAssertion: caller filtered to ready attachments with blob fields
    blobUrl: a.blobUrl!,
    mediaType: a.mediaType,
    filename: a.filename,
    sizeBytes: a.sizeBytes,
  }));
}

// `accept` for the composer's hidden file input. Text/code files often have no registered MIME,
// so the extension list keeps them pickable; the broad set lets any file through and the
// validation gate rejects unsupported ones with a toast. Shared by every composer (session + home).
export const ATTACHMENT_FILE_INPUT_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown,text/html,text/csv,application/json,application/xml,text/css,text/yaml,.txt,.md,.markdown,.html,.htm,.csv,.tsv,.json,.jsonc,.xml,.yaml,.yml,.toml,.ini,.cfg,.conf,.log,.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.cc,.hpp,.cs,.php,.sh,.bash,.zsh,.sql,.scss,.sass,.less";

export async function uploadAttachment(input: {
  id: string;
  file: File;
  workspaceId: string;
  // Absent on the home composer: the session does not exist yet (it is created on submit), so
  // the upload lands in a sessionless `pending/` folder. The DB row written at submit time
  // only stores the pointer, so the path scope is purely organizational.
  sessionId?: string;
}): Promise<{ blobPathname: string; blobUrl: string }> {
  const safeName = input.file.name.replace(/[^\w.\-]+/g, "_") || "file";
  const scope = input.sessionId ? `sessions/${input.sessionId}` : "pending";
  const pathname = `workspace/${input.workspaceId}/${scope}/${input.id}-${safeName}`;
  // PRIVATE Blob store: `access` is required (BlobAccessType = "public" | "private")
  // in @vercel/blob@2.4.0. The token is minted by /api/upload (handleUpload).
  const blob = await upload(pathname, input.file, {
    access: "private",
    handleUploadUrl: "/api/upload",
    contentType: input.file.type,
  });
  return { blobPathname: blob.pathname, blobUrl: blob.url };
}

// Short type label shown under the filename (ChatGPT-style file card). Prefer the extension
// (PNG, PDF, TS, …) since it's the most recognizable; fall back to the kind.
function attachmentTypeLabel(kind: AttachmentKind, filename: string): string {
  const ext = filename.includes(".") ? filename.split(".").pop()?.toUpperCase() : undefined;
  if (ext && ext.length <= 5) return ext;
  if (kind === "image") return "Image";
  if (kind === "pdf") return "PDF";
  return "Text";
}

// One compact, uniform attachment card — used both in the composer (with a remove button +
// upload status) and in the sent message thread (wrapped in a link). Images show a small
// thumbnail; everything else shows a file icon. Fixed size so it never overflows or reflows.
export function AttachmentCard({
  kind,
  filename,
  src,
  status,
  error,
  onRemove,
}: {
  kind: AttachmentKind;
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
    <div className="group/att relative flex w-[200px] items-center gap-2.5 rounded-xl border border-ink-subtle/30 bg-surface px-2.5 py-2">
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
        <div className={`text-[11px] ${status === "error" ? "text-danger" : "text-ink-subtle"}`}>
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

export function ComposerAttachments({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2">
      {attachments.map((att) => (
        <AttachmentCard
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
