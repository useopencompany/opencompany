"use client";

import { ATTACHMENT_IMAGE_MIME_TYPES, ATTACHMENT_MAX_BYTES } from "@opencompany/agent-runtime";
import { ImagePlus, Send, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import { ComposerAttachments, type PendingAttachment } from "@/components/composer-attachments";
import { type FeedbackActionState, submitFeedback } from "@/lib/feedback/actions";
import { uploadFeedbackImage } from "@/lib/feedback/upload-image";

const kindOptions = [
  { value: "bug", label: "Bug" },
  { value: "feedback", label: "Feedback" },
  { value: "idea", label: "Idea" },
] as const;

const MAX_FEEDBACK_IMAGES = 3;
const IMAGE_MIME_TYPES = new Set<string>(ATTACHMENT_IMAGE_MIME_TYPES);

type Props = {
  open: boolean;
  onClose: () => void;
  // Enables image attachments (drag / paste / browse). Absent on surfaces without a workspace
  // context — the dialog then stays text-only. The bytes are uploaded under this workspace's scope.
  workspaceId?: string | undefined;
};

function sessionIdFromPathname(pathname: string | null) {
  // Session pages live under both surfaces: /company/session/<id> and /personal/session/<id>.
  const [surface, section, encodedSessionId] = pathname?.split("/").filter(Boolean) ?? [];
  if (surface !== "company" && surface !== "personal") return "";
  if (section !== "session" || !encodedSessionId) return "";

  try {
    return decodeURIComponent(encodedSessionId);
  } catch {
    return encodedSessionId;
  }
}

function FeedbackForm({
  onClose,
  workspaceId,
}: {
  onClose: () => void;
  workspaceId?: string | undefined;
}) {
  const [state, formAction, isPending] = useActionState<FeedbackActionState | null, FormData>(
    submitFeedback,
    null,
  );
  const pathname = usePathname();
  const sessionId = sessionIdFromPathname(pathname);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const imagesEnabled = Boolean(workspaceId);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const dragCounterRef = useRef(0);

  // Mirror attachments into a ref so unmount cleanup can revoke object URLs without re-subscribing.
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  useEffect(
    () => () => {
      for (const attachment of attachmentsRef.current) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
    },
    [],
  );

  const acceptImages = useCallback(
    (files: File[]) => {
      if (!workspaceId) return;
      setAttachError(null);
      setAttachments((prev) => {
        const next = [...prev];
        for (const file of files) {
          if (next.length >= MAX_FEEDBACK_IMAGES) {
            setAttachError(`Up to ${MAX_FEEDBACK_IMAGES} images.`);
            break;
          }
          if (!IMAGE_MIME_TYPES.has(file.type)) {
            setAttachError("Only PNG, JPEG, WebP, or GIF images.");
            continue;
          }
          if (file.size > ATTACHMENT_MAX_BYTES) {
            setAttachError("Each image must be under 25 MB.");
            continue;
          }

          const id = crypto.randomUUID();
          next.push({
            id,
            filename: file.name || "image",
            mediaType: file.type,
            kind: "image",
            sizeBytes: file.size,
            status: "uploading",
            previewUrl: URL.createObjectURL(file),
          });
          void uploadFeedbackImage({ id, file, workspaceId })
            .then((res) =>
              setAttachments((cur) =>
                cur.map((a) => (a.id === id ? { ...a, status: "ready", ...res } : a)),
              ),
            )
            .catch((err) =>
              setAttachments((cur) =>
                cur.map((a) =>
                  a.id === id
                    ? {
                        ...a,
                        status: "error",
                        error: err instanceof Error ? err.message : "Upload failed",
                      }
                    : a,
                ),
              ),
            );
        }
        return next;
      });
    },
    [workspaceId],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => messageRef.current?.focus());

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      // Attachment state + object URLs are cleared on unmount: a successful submit auto-closes the
      // dialog, which unmounts this form (FeedbackDialog renders null when closed).
      const timer = setTimeout(onClose, 2500);
      return () => clearTimeout(timer);
    }
  }, [state, onClose]);

  const isUploading = attachments.some((a) => a.status === "uploading");
  const readyImages = attachments.filter((a) => a.status === "ready");

  return (
    <form
      ref={formRef}
      className="relative w-full max-w-[520px] overflow-hidden rounded-lg border border-black/[0.1] bg-surface-raised shadow-[0_24px_64px_rgba(0,0,0,0.2),0_4px_14px_rgba(0,0,0,0.1)]"
      action={formAction}
      onPaste={(event) => {
        if (!imagesEnabled) return;
        const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
          file.type.startsWith("image/"),
        );
        if (files.length > 0) {
          event.preventDefault();
          acceptImages(files);
        }
      }}
      onDragEnter={(event) => {
        if (!imagesEnabled || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        // Stop the event from reaching SessionView's window-level drag listener, which would
        // otherwise also react to a drop meant for this dialog.
        event.stopPropagation();
        dragCounterRef.current += 1;
        setIsDragActive(true);
      }}
      onDragOver={(event) => {
        if (!imagesEnabled || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onDragLeave={(event) => {
        if (!imagesEnabled || !event.dataTransfer.types.includes("Files")) return;
        dragCounterRef.current -= 1;
        if (dragCounterRef.current <= 0) {
          dragCounterRef.current = 0;
          setIsDragActive(false);
        }
      }}
      onDrop={(event) => {
        if (!imagesEnabled || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        // Critical: without stopPropagation the drop bubbles to SessionView's window `drop`
        // listener, which attaches the image to the open chat ("model can't read images").
        event.stopPropagation();
        dragCounterRef.current = 0;
        setIsDragActive(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) acceptImages(files);
      }}
    >
      {sessionId && <input type="hidden" name="sessionId" value={sessionId} />}
      {readyImages.map((attachment) => (
        <input
          key={attachment.id}
          type="hidden"
          name="images"
          value={JSON.stringify({
            blobPathname: attachment.blobPathname,
            blobUrl: attachment.blobUrl,
            filename: attachment.filename,
            mediaType: attachment.mediaType,
          })}
        />
      ))}

      {isDragActive && imagesEnabled ? (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-canvas/85 backdrop-blur-sm"
          aria-hidden="true"
        >
          <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-ink-subtle px-8 py-6">
            <ImagePlus size={22} strokeWidth={1.6} className="text-ink-muted" />
            <p className="text-[13px] font-medium text-ink">Drop image to attach</p>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between border-b border-black/[0.08] px-4 py-3">
        <h2 id="feedback-title" className="text-[14px] font-semibold text-ink">
          Send feedback
        </h2>
        <button
          type="button"
          aria-label="Close feedback"
          onClick={onClose}
          className="rounded-md p-1 text-ink/55 transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <X size={16} strokeWidth={1.8} />
        </button>
      </div>

      <div className="flex flex-col gap-4 px-4 py-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
            Type
          </span>
          <select
            name="kind"
            defaultValue="bug"
            disabled={isPending}
            className="h-8 rounded-md border border-border bg-surface px-2 text-[13px] text-ink outline-none transition-colors focus:border-ink/30 focus:ring-1 focus:ring-ink/15 disabled:opacity-60"
          >
            {kindOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
            Feedback
          </span>
          <textarea
            ref={messageRef}
            name="message"
            rows={9}
            minLength={3}
            maxLength={4000}
            disabled={isPending}
            placeholder="Tell us what happened, what you expected, or what you want to see."
            className="min-h-[184px] resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-[13px] leading-5 text-ink outline-none transition-colors placeholder:text-ink/35 focus:border-ink/30 focus:ring-1 focus:ring-ink/15 disabled:opacity-60"
          />
        </label>

        {imagesEnabled ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                className="hidden"
                onChange={(event) => {
                  acceptImages(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isPending || attachments.length >= MAX_FEEDBACK_IMAGES}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                <ImagePlus size={13} strokeWidth={1.9} />
                Attach image
              </button>
              <span className="text-[11.5px] text-ink-subtle">or drag &amp; drop · paste ⌘V</span>
            </div>
            {attachments.length > 0 && (
              <ComposerAttachments attachments={attachments} onRemove={removeAttachment} />
            )}
            {attachError && <p className="text-[11.5px] text-danger">{attachError}</p>}
          </div>
        ) : null}

        {state && !state.ok && (
          <div className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-[12.5px] text-danger">
            {state.error}
          </div>
        )}

        {state?.ok && (
          <div className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-[12.5px] text-success">
            <span>Thanks, we are on it.</span>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-black/[0.08] px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 items-center rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          Close
        </button>
        <button
          type="submit"
          disabled={isPending || isUploading}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <Send size={13} strokeWidth={1.9} />
          {isPending ? "Sending..." : isUploading ? "Uploading..." : "Send"}
        </button>
      </div>
    </form>
  );
}

export default function FeedbackDialog({ open, onClose, workspaceId }: Props) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/20 px-4 py-8 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      // Safety net: the backdrop covers the whole viewport while the dialog is open, so any file
      // drop (on the form or beside it) bubbles here. preventDefault stops the browser opening the
      // file; stopPropagation stops SessionView's window-level drop listener from also grabbing it.
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <FeedbackForm onClose={onClose} workspaceId={workspaceId} />
    </div>
  );
}
