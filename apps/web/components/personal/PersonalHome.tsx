"use client";

import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { ModelPicker } from "@/components/agent-editor/ModelPicker";
import { showOutOfCreditsToast } from "@/components/billing/out-of-credits-toast";
import { Composer } from "@/components/Composer";
import {
  ATTACHMENT_FILE_INPUT_ACCEPT,
  ComposerAttachments,
  ComposerDropOverlay,
  toSubmitAttachments,
} from "@/components/composer-attachments";
import { PendingSessionView } from "@/components/personal/PendingSessionView";
import { usePersonalAgent } from "@/components/personal/PersonalAgentContext";
import { PersonalInbox } from "@/components/personal/PersonalInbox";
import { useToast } from "@/components/ToastProvider";
import { useComposerAttachments } from "@/components/useComposerAttachments";
import { VoiceTranscriptionButton } from "@/components/VoiceTranscriptionButton";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { createAgentSessionFromPrompt } from "@/lib/agent-sessions/actions";
import { seedSessionQueries } from "@/lib/agent-sessions/payload";
import { personalPaths } from "@/lib/personal/paths";
import { insertTranscriptDraft } from "@/lib/transcription/insert";

const TEXTAREA_MAX_HEIGHT_PX = 220;
const DEFAULT_MODEL_ID: AgentModelId = "moonshotai/kimi-k2.6";

// The /personal default view: the inbox attention-cards prototype stacked above a hero composer
// locked to the single personal agent (no agent picker). On submit it swaps to an optimistic
// session view on the very next frame (see PendingSessionView), creates the session in the
// background, and navigates to its URL behind that view — so Enter feels instant and the
// route swap is invisible.
export default function PersonalHome() {
  const { agent, userName } = usePersonalAgent();
  const { workspaceId } = useWorkspaceContext();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { showToast } = useToast();
  const [input, setInput] = useState("");
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [model, setModel] = useState<string>(agent.defaultModel || DEFAULT_MODEL_ID);
  const [error, setError] = useState<string | null>(null);
  // The just-submitted prompt, rendered as the optimistic session view until navigation to
  // the created session completes (cleared only on failure, where the composer — with the
  // input text untouched — comes back).
  const [pendingSession, setPendingSession] = useState<{
    content: string;
    submittedAt: string;
  } | null>(null);
  const [, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Image/file attachments via the shared composer hook. No session exists yet — uploads land in
  // a sessionless "pending/" path and the pointers ride into createAgentSessionFromPrompt.
  const {
    attachments,
    setAttachments,
    acceptFiles,
    removeAttachment,
    isDragActive,
    isUploading,
    handlePasteFiles,
    dragHandlers,
  } = useComposerAttachments({
    workspaceId,
    modelName: model || DEFAULT_MODEL_ID,
    uploadScope: { kind: "pending" },
  });
  const ready = attachments.filter((a) => a.status === "ready" && a.blobPathname && a.blobUrl);
  const hasUploadError = attachments.some((a) => a.status === "error");
  // Submit needs text OR a ready attachment, and is blocked while any upload is in flight or
  // errored (so an image is never silently dropped, and a broken upload can't be sent).
  const canSubmit = Boolean(
    (input.trim() || ready.length > 0) &&
      !pendingSession &&
      !isUploading &&
      !hasUploadError &&
      !voiceRecording,
  );

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (input.length === 0) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, [input]);

  const insertTranscription = (text: string) => {
    const el = textareaRef.current;
    const next = insertTranscriptDraft({
      value: input,
      transcript: text,
      selectionStart: el?.selectionStart ?? input.length,
      selectionEnd: el?.selectionEnd ?? input.length,
    });
    setInput(next.value);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = () => {
    const content = input.trim();
    if (
      (!content && ready.length === 0) ||
      pendingSession ||
      isUploading ||
      hasUploadError ||
      voiceRecording
    )
      return;
    setError(null);
    setPendingSession({ content, submittedAt: new Date().toISOString() });
    startTransition(async () => {
      const result = await createAgentSessionFromPrompt(
        agent.id,
        content,
        model || undefined,
        toSubmitAttachments(ready),
        { surface: "personal" },
      );
      if (!result.ok) {
        setPendingSession(null);
        if ("redirectTo" in result) {
          showOutOfCreditsToast({
            showToast,
            router,
            redirectTo: result.redirectTo,
            reason: "reason" in result ? String(result.reason) : undefined,
          });
          return;
        }
        setError(result.error);
        return;
      }
      // Sent — the destination session paints the image from the persisted attachment (served via
      // /api/attachments), so the local blob previews aren't needed: revoke + clear the tray.
      attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
      setAttachments([]);
      // Seed the detail cache before navigating so SessionView paints synchronously from it —
      // the pending view is then replaced by an identical frame and only the URL changes.
      seedSessionQueries(queryClient, workspaceId, result.detail);
      router.push(personalPaths.session(result.session.id));
    });
  };

  if (pendingSession) {
    return (
      <PendingSessionView
        agentId={agent.id}
        agentName={agent.name}
        modelName={model || DEFAULT_MODEL_ID}
        fallbackModelId={DEFAULT_MODEL_ID}
        content={pendingSession.content}
        submittedAt={pendingSession.submittedAt}
      />
    );
  }

  return (
    <main className="relative flex h-full flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10">
      <div className="flex w-full max-w-[600px] flex-col gap-10">
        <PersonalInbox
          userName={userName}
          onOpenSession={(id) => router.push(personalPaths.session(id))}
        />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="relative"
          {...dragHandlers}
        >
          {isDragActive ? <ComposerDropOverlay className="rounded-2xl" /> : null}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ATTACHMENT_FILE_INPUT_ACCEPT}
            className="hidden"
            onChange={(event) => {
              acceptFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <ComposerAttachments attachments={attachments} onRemove={removeAttachment} />
          <Composer
            variant="expanded"
            error={error}
            input={
              <textarea
                ref={textareaRef}
                value={input}
                readOnly={voiceRecording}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (voiceRecording) {
                    event.preventDefault();
                    return;
                  }
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    submit();
                  }
                }}
                onPaste={(event) => {
                  // Files in the clipboard (e.g. a screenshot) attach via the shared hook, which
                  // also stops the browser pasting them into the textarea. Text pastes fall through.
                  handlePasteFiles(event);
                }}
                rows={1}
                placeholder={`Message ${agent.name}`}
                className="min-h-9 w-full resize-none content-center bg-transparent text-[15px] leading-6 tracking-[-0.005em] text-ink placeholder:text-ink-subtle outline-none"
                style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
              />
            }
            leftControls={
              <>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Attach file"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-surface-hover hover:text-ink"
                >
                  <Plus size={15} strokeWidth={1.75} />
                </button>
                <ModelPicker
                  value={model || DEFAULT_MODEL_ID}
                  fallbackModelId={DEFAULT_MODEL_ID}
                  onChange={(modelId) => setModel(modelId)}
                />
              </>
            }
            action={
              <div className="flex items-center gap-1.5">
                <VoiceTranscriptionButton
                  onTranscription={insertTranscription}
                  onRecordingChange={setVoiceRecording}
                  disabled={Boolean(pendingSession)}
                  variant="action"
                />
                {!voiceRecording ? (
                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Start session"
                  >
                    <ArrowUp size={13} strokeWidth={2} />
                  </button>
                ) : null}
              </div>
            }
          />
        </form>
      </div>
    </main>
  );
}
