"use client";

import {
  ATTACHMENT_MAX_PER_MESSAGE,
  modelSupportsAttachments,
  validateAttachmentCandidate,
} from "@opencompany/agent-runtime";
import {
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type PendingAttachment, uploadAttachment } from "@/components/composer-attachments";
import { useToast } from "@/components/ToastProvider";

// Where uploads land before they are attached to a message. A session composer keys the blob
// path to its session; the home composer has no session yet (it is created on submit), so it
// uploads to a sessionless "pending/" path and the pointer is carried into session creation.
export type AttachmentUploadScope = { kind: "session"; sessionId: string } | { kind: "pending" };

/**
 * Drag/drop, paste and file-pick attachment handling shared by every composer (session + the
 * two home composers). Owns the pending-attachment state, the client-side validation/capability
 * gate, the upload lifecycle, the window-wide drop interception and the drop-overlay state.
 *
 * Behavior is identical to the logic that previously lived inline in SessionView, plus a mounted
 * guard so a late upload callback can't setState after the composer unmounts (the home composer
 * navigates away the instant a session is created).
 */
export function useComposerAttachments(opts: {
  workspaceId: string;
  /** Drives the per-file image/PDF capability gate. Reading the latest value at call time means
   *  switching the model on the home composer takes effect without re-creating callbacks. */
  modelName: string;
  uploadScope: AttachmentUploadScope;
  enabled?: boolean;
}) {
  const { workspaceId, modelName, uploadScope, enabled = true } = opts;
  const { showToast } = useToast();
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const dragCounterRef = useRef(0);

  // Latest-attachments ref so the unmount cleanup can revoke all outstanding object URLs with an
  // empty-dep effect (fires on unmount only) instead of re-running on every change.
  const attachmentsRef = useRef(attachments);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // Guards async upload callbacks. On the home composer the component unmounts the instant the
  // session is created (navigation), so a late .then/.catch must not setState on a gone tree.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Read capability + scope through refs inside acceptFiles so the callback identity stays stable
  // across model/scope changes (the window-drop effect depends on it and shouldn't re-bind).
  const capabilityRef = useRef(modelSupportsAttachments(modelName));
  useEffect(() => {
    capabilityRef.current = modelSupportsAttachments(modelName);
  }, [modelName]);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      dragCounterRef.current = 0;
      setIsDragActive(false);
    }
  }, [enabled]);
  const uploadScopeRef = useRef(uploadScope);
  useEffect(() => {
    uploadScopeRef.current = uploadScope;
  }, [uploadScope]);

  const acceptFiles = useCallback(
    (files: File[]) => {
      if (!enabledRef.current) return;
      setAttachments((prev) => {
        const next = [...prev];
        for (const file of files) {
          if (next.length >= ATTACHMENT_MAX_PER_MESSAGE) {
            showToast({
              title: "Limit reached",
              description: `Max ${ATTACHMENT_MAX_PER_MESSAGE} files.`,
              tone: "default",
            });
            break;
          }
          const validation = validateAttachmentCandidate({
            mediaType: file.type,
            sizeBytes: file.size,
            filename: file.name,
          });
          if (!validation.ok) {
            // `size` covers both oversized AND empty (0-byte) files — split the copy so an empty
            // file doesn't claim to be "too large".
            const isEmpty = validation.reason === "size" && file.size <= 0;
            showToast({
              title: isEmpty
                ? "Empty file"
                : validation.reason === "size"
                  ? "File too large"
                  : "Unsupported file",
              description: isEmpty
                ? "This file is empty (0 bytes)."
                : validation.reason === "size"
                  ? "Max 25 MB (images/PDFs) or 2 MB (text files)."
                  : "Images, PDFs, and common text/code files.",
              tone: "default",
            });
            continue;
          }
          // Image/PDF need the model to support them; text is always allowed.
          const capability = capabilityRef.current;
          if (validation.kind === "pdf" && !capability.pdf) {
            showToast({
              title: "Unsupported file",
              description: "The selected model can't read PDFs.",
              tone: "default",
            });
            continue;
          }
          if (validation.kind === "image" && !capability.images) {
            showToast({
              title: "Unsupported file",
              description: "The selected model can't read images.",
              tone: "default",
            });
            continue;
          }
          const id = crypto.randomUUID();
          next.push({
            id,
            filename: file.name,
            mediaType: file.type,
            kind: validation.kind,
            sizeBytes: file.size,
            status: "uploading",
            ...(validation.kind === "image" ? { previewUrl: URL.createObjectURL(file) } : {}),
          });
          const scope = uploadScopeRef.current;
          void uploadAttachment({
            id,
            file,
            workspaceId,
            ...(scope.kind === "session" ? { sessionId: scope.sessionId } : {}),
          })
            .then((res) => {
              if (mountedRef.current) {
                setAttachments((cur) =>
                  cur.map((a) => (a.id === id ? { ...a, status: "ready", ...res } : a)),
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
    [workspaceId, showToast],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  // Revoke any still-live preview object URLs when the composer unmounts (e.g. navigating away
  // with unsent attachments) so they don't leak.
  useEffect(() => {
    return () => {
      for (const att of attachmentsRef.current) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      }
    };
  }, []);

  // Browsers don't always fire a final `dragleave` when the user drags out of the window —
  // without this, the drop overlay can stay stuck visible. Reset on window blur (e.g. tab
  // switch) so the overlay never outlives the gesture.
  useEffect(() => {
    if (!isDragActive) return;
    const reset = () => {
      dragCounterRef.current = 0;
      setIsDragActive(false);
    };
    window.addEventListener("blur", reset);
    return () => window.removeEventListener("blur", reset);
  }, [isDragActive]);

  // A file dropped anywhere in the window — not just on the composer drop zone — must NOT make
  // the browser navigate to / open the file (its default). Prevent that window-wide, and route
  // any in-window file drop into the composer as an attachment.
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

  // Extract files from a paste and attach them, stopping the browser from also pasting them into
  // the textarea (e.g. an image). Returns true if it consumed files — the caller can then run any
  // surface-specific text-paste handling only when this returns false.
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

  // Drop-overlay hover handlers for the composer's drop zone. The actual file handling is done by
  // the window-level drop handler above (so a drop anywhere attaches and the browser never opens
  // the file); these only drive the "Drop files to attach" overlay via a nesting-safe counter.
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

  return {
    attachments,
    setAttachments,
    acceptFiles,
    removeAttachment,
    isDragActive,
    isUploading,
    handlePasteFiles,
    dragHandlers,
  };
}
