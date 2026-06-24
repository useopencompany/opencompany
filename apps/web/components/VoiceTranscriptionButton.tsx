"use client";

import { LoaderCircle, Mic, Square, Trash2 } from "lucide-react";
import { useVoiceTranscription } from "@/components/useVoiceTranscription";

export function VoiceTranscriptionButton({
  onTranscription,
  disabled = false,
  variant = "toolbar",
}: {
  onTranscription: (text: string) => void;
  disabled?: boolean;
  variant?: "toolbar" | "action";
}) {
  const { cancel, isRecording, isSupported, isTranscribing, start, stop } = useVoiceTranscription({
    onTranscription,
  });

  if (!isSupported) return null;

  const busy = isRecording || isTranscribing;
  const sizeClass = variant === "action" ? "h-8 w-8 rounded-full" : "h-7 w-7 rounded-md";
  return (
    <>
      {isRecording ? (
        <button
          type="button"
          onClick={cancel}
          aria-label="Discard recording"
          title="Discard recording"
          className="flex h-7 w-7 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-surface-hover hover:text-danger"
        >
          <Trash2 size={13} strokeWidth={1.8} />
        </button>
      ) : null}
      <button
        type="button"
        disabled={disabled || isTranscribing}
        onClick={isRecording ? stop : start}
        aria-label={
          isTranscribing
            ? "Transcribing voice message"
            : isRecording
              ? "Stop recording"
              : "Record voice"
        }
        title={
          isTranscribing
            ? "Transcribing voice message"
            : isRecording
              ? "Stop recording"
              : "Record voice"
        }
        className={`flex items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${sizeClass} ${
          isRecording
            ? "bg-danger-bg text-danger hover:bg-danger-bg"
            : busy
              ? "text-ink-muted"
              : "text-ink-muted hover:bg-surface-hover hover:text-ink"
        }`}
      >
        {isTranscribing ? (
          <LoaderCircle size={14} strokeWidth={1.8} className="animate-spin" />
        ) : isRecording && variant !== "action" ? (
          <Square size={12} strokeWidth={2} />
        ) : (
          <Mic size={14} strokeWidth={1.75} />
        )}
      </button>
    </>
  );
}
