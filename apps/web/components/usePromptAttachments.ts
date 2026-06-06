"use client";

import { useCallback, useState } from "react";

// A large paste captured in the composer as a ".txt attachment" instead of being inlined
// into the textarea. `content` is the full pasted text; the server turns it into a durable
// file referenced from the message.
export type PromptAttachment = {
  id: string;
  label: string;
  content: string;
  bytes: number;
  lineCount: number;
};

// Pastes at/above this length become an attachment instead of filling the textarea.
export const PASTE_ATTACHMENT_THRESHOLD = 1000;

function measureBytes(content: string) {
  return new TextEncoder().encode(content).length;
}

function measureLines(content: string) {
  if (content.length === 0) return 0;
  return content.split("\n").length;
}

function labelFromContent(content: string) {
  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "Pasted text";
  return firstLine.length > 32 ? `${firstLine.slice(0, 29)}…` : firstLine;
}

function newClientId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `att-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export type UsePromptAttachments = {
  attachments: PromptAttachment[];
  /**
   * Capture a large text paste from a paste/drop event. Returns true when the paste was
   * turned into an attachment (the caller should then `preventDefault()` so the text does
   * not also land in the textarea).
   */
  addFromPaste: (data: DataTransfer | null | undefined) => boolean;
  remove: (id: string) => void;
  reorder: (fromId: string, toId: string) => void;
  clear: () => void;
  /** Replace the current attachments — used to restore them after a failed send. */
  restore: (items: PromptAttachment[]) => void;
};

export function usePromptAttachments(): UsePromptAttachments {
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);

  const addFromPaste = useCallback((data: DataTransfer | null | undefined) => {
    if (!data) return false;
    // Defer image handling to the existing image-paste path.
    const hasImage = Array.from(data.items ?? []).some(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );
    if (hasImage) return false;
    const text = data.getData("text/plain");
    if (!text || text.length < PASTE_ATTACHMENT_THRESHOLD) return false;
    setAttachments((current) => [
      ...current,
      {
        id: newClientId(),
        label: labelFromContent(text),
        content: text,
        bytes: measureBytes(text),
        lineCount: measureLines(text),
      },
    ]);
    return true;
  }, []);

  const remove = useCallback((id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }, []);

  const reorder = useCallback((fromId: string, toId: string) => {
    if (fromId === toId) return;
    setAttachments((current) => {
      const fromIndex = current.findIndex((attachment) => attachment.id === fromId);
      const toIndex = current.findIndex((attachment) => attachment.id === toId);
      if (fromIndex === -1 || toIndex === -1) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return current;
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  const clear = useCallback(() => setAttachments([]), []);

  const restore = useCallback((items: PromptAttachment[]) => setAttachments(items), []);

  return { attachments, addFromPaste, remove, reorder, clear, restore };
}
