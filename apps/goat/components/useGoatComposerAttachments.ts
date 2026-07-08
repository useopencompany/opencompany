"use client";

import {
  ATTACHMENT_MAX_PER_MESSAGE,
  modelSupportsAttachments,
  validateAttachmentCandidate,
} from "@opencompany/agent-runtime";
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
import {
  type PendingGoatAttachment,
  uploadGoatAttachment,
} from "@/components/goat-composer-attachments";

export function useGoatComposerAttachments(input: { userWorkosId: string; modelName: string }) {
  const [attachments, setAttachments] = useState<PendingGoatAttachment[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const dragCounterRef = useRef(0);
  const attachmentsRef = useRef(attachments);
  const capabilityRef = useRef(modelSupportsAttachments(input.modelName));
  const mountedRef = useRef(true);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    capabilityRef.current = modelSupportsAttachments(input.modelName);
  }, [input.modelName]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const attachment of attachmentsRef.current) {
        if (attachment.previewUrl && typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      }
    };
  }, []);

  const acceptFiles = useCallback(
    (files: File[]) => {
      setAttachments((current) => {
        const next = [...current];
        for (const file of files) {
          if (next.length >= ATTACHMENT_MAX_PER_MESSAGE) {
            toast(`Max ${ATTACHMENT_MAX_PER_MESSAGE} files.`);
            break;
          }
          const validation = validateAttachmentCandidate({
            mediaType: file.type,
            sizeBytes: file.size,
            filename: file.name,
          });
          if (!validation.ok) {
            const isEmpty = validation.reason === "size" && file.size <= 0;
            toast(
              isEmpty
                ? "This file is empty."
                : validation.reason === "size"
                  ? "File too large."
                  : "Unsupported file.",
            );
            continue;
          }
          const capability = capabilityRef.current;
          if (validation.kind === "image" && !capability.images) {
            toast("This model can't read images.");
            continue;
          }
          if (validation.kind === "pdf" && !capability.pdf) {
            toast("This model can't read PDFs.");
            continue;
          }

          const id = crypto.randomUUID();
          const previewUrl =
            validation.kind === "image" && typeof URL.createObjectURL === "function"
              ? URL.createObjectURL(file)
              : undefined;
          next.push({
            id,
            filename: file.name,
            mediaType: file.type,
            kind: validation.kind,
            sizeBytes: file.size,
            status: "uploading",
            ...(previewUrl ? { previewUrl } : {}),
          });
          void uploadGoatAttachment({ id, file, userWorkosId: input.userWorkosId })
            .then((result) => {
              if (!mountedRef.current) return;
              setAttachments((latest) =>
                latest.map((attachment) =>
                  attachment.id === id ? { ...attachment, status: "ready", ...result } : attachment,
                ),
              );
            })
            .catch((error) => {
              if (!mountedRef.current) return;
              setAttachments((latest) =>
                latest.map((attachment) =>
                  attachment.id === id
                    ? { ...attachment, status: "error", error: String(error) }
                    : attachment,
                ),
              );
            });
        }
        return next;
      });
    },
    [input.userWorkosId],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const target = current.find((attachment) => attachment.id === id);
      if (target?.previewUrl && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(target.previewUrl);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const handlePasteFiles = useCallback(
    (event: ReactClipboardEvent): boolean => {
      const items = event.clipboardData?.items;
      if (!items) return false;
      const files = Array.from(items)
        .filter((item) => item.kind === "file")
        .flatMap((item) => {
          const file = item.getAsFile();
          return file ? [file] : [];
        });
      if (files.length === 0) return false;
      event.preventDefault();
      acceptFiles(files);
      return true;
    },
    [acceptFiles],
  );

  useEffect(() => {
    const onWindowDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const onWindowDrop = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      dragCounterRef.current = 0;
      setIsDragActive(false);
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

  const dragHandlers = useMemo(
    () => ({
      onDragEnter: (event: ReactDragEvent) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragCounterRef.current += 1;
        setIsDragActive(true);
      },
      onDragOver: (event: ReactDragEvent) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
      },
      onDragLeave: (event: ReactDragEvent) => {
        if (!event.dataTransfer.types.includes("Files")) return;
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

  return {
    attachments,
    setAttachments,
    acceptFiles,
    removeAttachment,
    handlePasteFiles,
    dragHandlers,
    isDragActive,
  };
}
