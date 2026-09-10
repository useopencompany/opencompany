import * as z from "zod";
import type { ChatMention } from "@/lib/chat-ui";

export type ChatComposerDraft = { input: string; mentions: ChatMention[] };

const draftSchema = z.object({
  input: z.string(),
  mentions: z.array(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("engine"), id: z.enum(["codex", "claude"]) }),
      z
        .object({ kind: z.literal("skill"), id: z.string(), name: z.string().optional() })
        .transform(({ kind, id, name }) => ({ kind, id, ...(name !== undefined ? { name } : {}) })),
      z.object({ kind: z.literal("workflow"), id: z.string() }),
    ]),
  ),
});

export function composerDraftKey(userId: string, workspaceId: string, sessionId: string | null) {
  return `opencompany:composer-draft:v1:${JSON.stringify([userId, workspaceId, sessionId])}`;
}

export function readComposerDraft(key: string): ChatComposerDraft | null {
  try {
    const value = window.sessionStorage.getItem(key);
    if (!value) return null;
    const result = draftSchema.safeParse(JSON.parse(value));
    return result.success ? result.data : null;
  } catch {
    // Unavailable storage or an invalid draft must not prevent composing a message.
    return null;
  }
}

export function persistComposerDraft(key: string, draft: ChatComposerDraft) {
  try {
    if (draft.input.length > 0) {
      window.sessionStorage.setItem(key, JSON.stringify(draft));
    } else {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Keep the live draft usable when storage is blocked or its quota is exhausted.
  }
}
