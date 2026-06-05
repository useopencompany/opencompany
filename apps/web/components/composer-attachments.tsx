"use client";

import type { AttachmentKind } from "@opencompany/agent-runtime";
import { upload } from "@vercel/blob/client";
import { FileText, X } from "lucide-react";

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

export async function uploadAttachment(input: {
  id: string;
  file: File;
  workspaceId: string;
  sessionId: string;
}): Promise<{ blobPathname: string; blobUrl: string }> {
  const safeName = input.file.name.replace(/[^\w.\-]+/g, "_") || "file";
  const pathname = `workspace/${input.workspaceId}/sessions/${input.sessionId}/${input.id}-${safeName}`;
  // PRIVATE Blob store: `access` is required (BlobAccessType = "public" | "private")
  // in @vercel/blob@2.4.0. The token is minted by /api/upload (handleUpload).
  const blob = await upload(pathname, input.file, {
    access: "private",
    handleUploadUrl: "/api/upload",
    contentType: input.file.type,
  });
  return { blobPathname: blob.pathname, blobUrl: blob.url };
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
        <div
          key={att.id}
          className="group relative flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] text-ink"
        >
          {att.kind === "image" && att.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- object-URL preview of a not-yet-uploaded local file; next/image can't optimize a blob: URL.
            <img src={att.previewUrl} alt={att.filename} className="h-8 w-8 rounded object-cover" />
          ) : (
            <FileText size={16} strokeWidth={1.75} className="text-ink-muted" />
          )}
          <span className="max-w-[140px] truncate">{att.filename}</span>
          {att.status === "uploading" ? <span className="text-ink-subtle">…</span> : null}
          {att.status === "error" ? (
            <span className="text-danger" title={att.error}>
              !
            </span>
          ) : null}
          <button
            type="button"
            aria-label={`Remove ${att.filename}`}
            onClick={() => onRemove(att.id)}
            className="ml-1 text-ink-muted hover:text-ink"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  );
}
