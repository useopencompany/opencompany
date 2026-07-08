"use client";

import type { AttachmentKind } from "@opencompany/agent-runtime";
import { upload } from "@vercel/blob/client";
import { FileText, Upload, X } from "lucide-react";
import { goatAttachmentBlobPrefix } from "@/lib/attachments";

export type PendingGoatAttachment = {
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

export const GOAT_ATTACHMENT_FILE_INPUT_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown,text/html,text/csv,application/json,application/xml,text/css,text/yaml,.txt,.md,.markdown,.html,.htm,.csv,.tsv,.json,.jsonc,.xml,.yaml,.yml,.toml,.ini,.cfg,.conf,.log,.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.cc,.hpp,.cs,.php,.sh,.bash,.zsh,.sql,.scss,.sass,.less";

export function toSubmitGoatAttachments(attachments: PendingGoatAttachment[]) {
  return attachments.map((attachment) => ({
    // biome-ignore lint/style/noNonNullAssertion: caller filters to ready attachments with blob fields
    blobPathname: attachment.blobPathname!,
    // biome-ignore lint/style/noNonNullAssertion: caller filters to ready attachments with blob fields
    blobUrl: attachment.blobUrl!,
    mediaType: attachment.mediaType,
    filename: attachment.filename,
    sizeBytes: attachment.sizeBytes,
  }));
}

export async function uploadGoatAttachment(input: {
  id: string;
  file: File;
  userWorkosId: string;
}): Promise<{ blobPathname: string; blobUrl: string }> {
  const safeName = input.file.name.replace(/[^\w.\-]+/g, "_") || "file";
  const pathname = `${goatAttachmentBlobPrefix(input.userWorkosId)}pending/${input.id}-${safeName}`;
  const blob = await upload(pathname, input.file, {
    access: "private",
    handleUploadUrl: "/api/upload",
    contentType: input.file.type,
  });
  return { blobPathname: blob.pathname, blobUrl: blob.url };
}

export function GoatComposerDropOverlay() {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-2xl"
      aria-hidden="true"
    >
      <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-ink-subtle bg-canvas/90 px-8 py-6 backdrop-blur-sm">
        <Upload size={22} strokeWidth={1.6} className="text-ink-muted" />
        <p className="text-[13px] font-medium text-ink">Drop files to attach</p>
        <p className="text-[11.5px] text-ink-subtle">Images, PDFs, text and code</p>
      </div>
    </div>
  );
}

export function GoatComposerAttachments({
  attachments,
  onRemove,
}: {
  attachments: PendingGoatAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2">
      {attachments.map((attachment) => (
        <GoatAttachmentCard
          key={attachment.id}
          kind={attachment.kind}
          filename={attachment.filename}
          src={attachment.previewUrl}
          status={attachment.status}
          error={attachment.error}
          onRemove={() => onRemove(attachment.id)}
        />
      ))}
    </div>
  );
}

export function GoatAttachmentCard({
  kind,
  filename,
  src,
  status,
  error,
  onRemove,
}: {
  kind: AttachmentKind;
  filename: string;
  src?: string | undefined;
  status?: "uploading" | "ready" | "error" | undefined;
  error?: string | undefined;
  onRemove?: (() => void) | undefined;
}) {
  const subtitle =
    status === "uploading"
      ? "Uploading..."
      : status === "error"
        ? (error ?? "Upload failed")
        : attachmentTypeLabel(kind, filename);

  return (
    <div className="group/att relative flex w-[200px] items-center gap-2.5 rounded-xl border border-ink-subtle/30 bg-surface px-2.5 py-2 text-ink">
      {kind === "image" && src ? (
        // eslint-disable-next-line @next/next/no-img-element -- blob/attachment thumbnail.
        <img src={src} alt={filename} className="h-9 w-9 shrink-0 rounded-md object-cover" />
      ) : (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink-muted">
          <FileText size={16} strokeWidth={1.75} />
        </div>
      )}
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate text-[12.5px] font-medium">{filename}</div>
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

function attachmentTypeLabel(kind: AttachmentKind, filename: string) {
  const ext = filename.includes(".") ? filename.split(".").pop()?.toUpperCase() : undefined;
  if (ext && ext.length <= 5) return ext;
  if (kind === "image") return "Image";
  if (kind === "pdf") return "PDF";
  return "Text";
}
