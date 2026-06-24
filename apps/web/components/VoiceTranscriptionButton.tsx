"use client";

import { Check, LoaderCircle, Mic, Square, Trash2, X } from "lucide-react";
import { useEffect } from "react";
import { useVoiceTranscription } from "@/components/useVoiceTranscription";

export function VoiceTranscriptionButton({
  onTranscription,
  onRecordingChange,
  disabled = false,
  variant = "toolbar",
}: {
  onTranscription: (text: string) => void;
  onRecordingChange?: (isRecording: boolean) => void;
  disabled?: boolean;
  variant?: "toolbar" | "action";
}) {
  const { audioLevels, cancel, isRecording, isSupported, isTranscribing, start, stop } =
    useVoiceTranscription({
      onTranscription,
    });

  useEffect(() => {
    onRecordingChange?.(isRecording);
    return () => onRecordingChange?.(false);
  }, [isRecording, onRecordingChange]);

  if (!isSupported) return null;

  const busy = isRecording || isTranscribing;
  const sizeClass = variant === "action" ? "h-8 w-8 rounded-full" : "h-7 w-7 rounded-md";
  const discardSizeClass = variant === "action" ? "h-8 w-8" : "h-7 w-7";
  const recordingAnimationClass = isRecording ? "voice-recording-button" : "";
  const idleClass =
    variant === "action"
      ? "bg-surface-hover text-ink-muted shadow-[inset_0_0_0_1px_rgba(17,17,17,0.04)] hover:bg-surface-active hover:text-ink"
      : "text-ink-muted hover:bg-surface-hover hover:text-ink";
  const busyClass =
    variant === "action"
      ? "bg-surface-hover text-ink-muted shadow-[inset_0_0_0_1px_rgba(17,17,17,0.04)]"
      : "text-ink-muted";

  if (isRecording && variant === "action") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="voice-chatgpt-recording">
          <span aria-hidden="true" className="voice-chatgpt-waveform min-w-0 flex-1">
            {audioLevels.map((level, index) => (
              <span
                key={index}
                className="voice-chatgpt-bar"
                style={{
                  height: `${Math.round(10 + level * 38)}px`,
                  opacity: Math.max(0.5, Math.min(0.92, 0.56 + level * 0.34)),
                }}
              />
            ))}
          </span>
        </span>
        <button
          type="button"
          onClick={cancel}
          aria-label="Discard recording"
          title="Discard recording"
          className="voice-chatgpt-control relative z-20 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors"
        >
          <X size={18} strokeWidth={1.9} />
        </button>
        <button
          type="button"
          onClick={stop}
          aria-label="Finish recording"
          title="Finish recording"
          className="voice-chatgpt-control voice-chatgpt-accept relative z-20 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors"
        >
          <Check size={19} strokeWidth={1.9} />
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {isRecording ? (
        <button
          type="button"
          onClick={cancel}
          aria-label="Discard recording"
          title="Discard recording"
          className={`voice-recording-discard flex items-center justify-center rounded-full bg-surface-selected text-danger transition-colors hover:bg-danger-bg hover:text-danger ${discardSizeClass}`}
        >
          <Trash2 size={variant === "action" ? 14 : 13} strokeWidth={1.85} />
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
        className={`${recordingAnimationClass} flex items-center justify-center transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${sizeClass} ${
          isRecording
            ? "bg-danger-bg text-danger shadow-[0_0_0_1px_rgba(220,38,38,0.12)] hover:bg-danger-bg"
            : busy
              ? busyClass
              : idleClass
        }`}
      >
        <span className={isRecording ? "voice-recording-icon" : undefined}>
          {isTranscribing ? (
            <LoaderCircle size={14} strokeWidth={1.8} className="animate-spin" />
          ) : isRecording && variant !== "action" ? (
            <Square size={12} strokeWidth={2} />
          ) : (
            <Mic size={14} strokeWidth={1.75} />
          )}
        </span>
      </button>
    </span>
  );
}
