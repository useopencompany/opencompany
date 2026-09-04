"use client";

import { modelSupportsAttachments } from "@opencompany/agent-runtime";
import { toast } from "@opencompany/ui/components/sonner";
import {
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PendingChatAttachment } from "@/components/chat/ChatComposerAttachments";
import {
  CHAT_ATTACHMENT_MAX_PER_MESSAGE,
  validateChatAttachmentCandidate,
} from "@/lib/chat-attachment-formats";

// Drag/drop, paste and file-pick attachment handling for the opencompany chat
// composer. Owns the pending state, client-side validation/capability gate, upload lifecycle, window-wide
// drop interception and the drop-overlay state.
export function useChatAttachments(opts: {
  // Drives the per-file image/PDF capability gate; read at call time so a model
  // switch applies without re-creating callbacks.
  modelName: string;
  // Disabled surfaces ignore picker, paste, and drop input.
  enabled?: boolean;
  // Cloud engines can make uploaded files available through their own filesystem even when
  // the gateway model catalog does not advertise native PDF/image message parts.
  capabilities?: { images: boolean; pdf: boolean };
  // The canonical API returns an opaque attachment id.
  upload: (input: {
    file: File;
    mediaType: string;
    pendingId: string;
  }) => Promise<{ id: string; canonical?: boolean }>;
}) {
  const { modelName, enabled = true, upload } = opts;
  const imagesOverride = opts.capabilities?.images;
  const pdfOverride = opts.capabilities?.pdf;
  const [attachments, setAttachments] = useState<PendingChatAttachment[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const dragCounterRef = useRef(0);

  const attachmentsRef = useRef(attachments);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const capabilityRef = useRef(
    imagesOverride === undefined || pdfOverride === undefined
      ? modelSupportsAttachments(modelName)
      : { images: imagesOverride, pdf: pdfOverride },
  );
  useEffect(() => {
    capabilityRef.current =
      imagesOverride === undefined || pdfOverride === undefined
        ? modelSupportsAttachments(modelName)
        : { images: imagesOverride, pdf: pdfOverride };
  }, [imagesOverride, modelName, pdfOverride]);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      dragCounterRef.current = 0;
      // Disabled attachment surfaces should immediately clear stale drag UI.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsDragActive(false);
    }
  }, [enabled]);

  const acceptFiles = useCallback(
    (files: File[]) => {
      if (!enabledRef.current) return;
      setAttachments((prev) => {
        const next = [...prev];
        for (const file of files) {
          if (next.length >= CHAT_ATTACHMENT_MAX_PER_MESSAGE) {
            toast.error(`Max ${CHAT_ATTACHMENT_MAX_PER_MESSAGE} files per message.`);
            break;
          }
          const validation = validateChatAttachmentCandidate({
            mediaType: file.type,
            filename: file.name,
            sizeBytes: file.size,
          });
          if (!validation.ok) {
            toast.error(validation.message);
            continue;
          }
          const capability = capabilityRef.current;
          if (validation.kind === "pdf" && !capability.pdf) {
            toast.error("The selected model can't read PDFs.");
            continue;
          }
          if (validation.kind === "image" && !capability.images) {
            toast.error("The selected model can't read images.");
            continue;
          }
          const id = crypto.randomUUID();
          next.push({
            id,
            filename: file.name,
            mediaType: validation.mediaType,
            kind: validation.kind,
            sizeBytes: file.size,
            status: "uploading",
            ...(validation.kind === "image" ? { previewUrl: URL.createObjectURL(file) } : {}),
          });
          const uploadPromise = upload({ file, mediaType: validation.mediaType, pendingId: id });
          void uploadPromise
            .then((res) => {
              if (mountedRef.current) {
                setAttachments((cur) =>
                  cur.map((a) =>
                    a.id === id
                      ? {
                          ...a,
                          ...res,
                          id: ("id" in res ? res.id : undefined) ?? a.id,
                          status: "ready",
                        }
                      : a,
                  ),
                );
              }
            })
            .catch((err) => {
              if (mountedRef.current) {
                setAttachments((cur) =>
                  cur.map((a) => (a.id === id ? { ...a, status: "error", error: String(err) } : a)),
                );
              }
            });
        }
        return next;
      });
    },
    [upload],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments((prev) => {
      for (const attachment of prev) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      return [];
    });
  }, []);

  // Revoke any still-live preview object URLs on unmount so they don't leak.
  useEffect(() => {
    return () => {
      for (const att of attachmentsRef.current) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      }
    };
  }, []);

  // Browsers don't always fire a final `dragleave` when the drag exits the
  // window; reset on blur so the overlay never outlives the gesture.
  useEffect(() => {
    if (!isDragActive) return;
    const reset = () => {
      dragCounterRef.current = 0;
      setIsDragActive(false);
    };
    window.addEventListener("blur", reset);
    return () => window.removeEventListener("blur", reset);
  }, [isDragActive]);

  // A file dropped anywhere in the window must not make the browser open it;
  // prevent that window-wide and route any in-window file drop into the composer.
  useEffect(() => {
    const onWindowDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const onWindowDrop = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      dragCounterRef.current = 0;
      setIsDragActive(false);
      if (!enabledRef.current) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) acceptFiles(files);
    };
    window.addEventListener("dragover", onWindowDragOver);
    window.addEventListener("drop", onWindowDrop);
    return () => {
      window.removeEventListener("dragover", onWindowDragOver);
      window.removeEventListener("drop", onWindowDrop);
    };
  }, [acceptFiles]);

  // Extract files from a paste and attach them; returns true when it consumed
  // files so the caller skips its own text-paste handling.
  const handlePasteFiles = useCallback(
    (event: ReactClipboardEvent): boolean => {
      const items = event.clipboardData?.items;
      if (!enabledRef.current) return false;
      if (!items) return false;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
      if (files.length === 0) return false;
      event.preventDefault();
      acceptFiles(files);
      return true;
    },
    [acceptFiles],
  );

  // Drop-overlay hover handlers; the window-level drop handler above does the
  // actual attaching, these only drive the overlay via a nesting-safe counter.
  const dragHandlers = useMemo(
    () => ({
      onDragEnter: (event: ReactDragEvent) => {
        if (!enabledRef.current) return;
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragCounterRef.current += 1;
        setIsDragActive(true);
      },
      onDragOver: (event: ReactDragEvent) => {
        if (!enabledRef.current) return;
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
      },
      onDragLeave: (event: ReactDragEvent) => {
        if (!enabledRef.current) return;
        event.preventDefault();
        dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
        if (dragCounterRef.current === 0) setIsDragActive(false);
      },
      onDrop: () => {
        dragCounterRef.current = 0;
        setIsDragActive(false);
      },
    }),
    [],
  );

  const isUploading = attachments.some((a) => a.status === "uploading");
  const hasFailed = attachments.some((a) => a.status === "error");

  return {
    attachments,
    setAttachments,
    acceptFiles,
    removeAttachment,
    clearAttachments,
    isDragActive,
    isUploading,
    hasFailed,
    handlePasteFiles,
    dragHandlers,
  };
}
