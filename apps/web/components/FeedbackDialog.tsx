"use client";

import { ImagePlus, Send, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { type FeedbackActionState, submitFeedback } from "@/lib/feedback/actions";

const kindOptions = [
  { value: "bug", label: "Bug" },
  { value: "feedback", label: "Feedback" },
  { value: "idea", label: "Idea" },
] as const;

type Props = {
  open: boolean;
  onClose: () => void;
};

function sessionIdFromPathname(pathname: string | null) {
  const [section, encodedSessionId] = pathname?.split("/").filter(Boolean) ?? [];
  if (section !== "session" || !encodedSessionId) return "";

  try {
    return decodeURIComponent(encodedSessionId);
  } catch {
    return encodedSessionId;
  }
}

const SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const SCREENSHOT_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

function FeedbackForm({ onClose }: { onClose: () => void }) {
  const [state, formAction, isPending] = useActionState<FeedbackActionState | null, FormData>(
    submitFeedback,
    null,
  );
  const pathname = usePathname();
  const sessionId = sessionIdFromPathname(pathname);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);

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
      clearScreenshot();
      const timer = setTimeout(onClose, 2500);
      return () => clearTimeout(timer);
    }
  }, [state, onClose]);

  function handleScreenshotChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setScreenshotError(null);

    if (!file) return;

    if (file.size > SCREENSHOT_MAX_BYTES) {
      setScreenshotError("Screenshot must be under 10 MB.");
      event.target.value = "";
      return;
    }

    const url = URL.createObjectURL(file);
    setScreenshotPreview(url);
  }

  function clearScreenshot() {
    if (screenshotPreview) URL.revokeObjectURL(screenshotPreview);
    setScreenshotPreview(null);
    setScreenshotError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <form
      ref={formRef}
      className="w-full max-w-[520px] overflow-hidden rounded-lg border border-black/[0.1] bg-surface-raised shadow-[0_24px_64px_rgba(0,0,0,0.2),0_4px_14px_rgba(0,0,0,0.1)]"
      action={formAction}
      encType="multipart/form-data"
    >
      {sessionId && <input type="hidden" name="sessionId" value={sessionId} />}

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

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
            Screenshot{" "}
            <span className="normal-case font-normal tracking-normal text-ink/40">— optional</span>
          </span>

          {screenshotPreview ? (
            <div className="relative w-fit">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={screenshotPreview}
                alt="Screenshot preview"
                className="max-h-[120px] max-w-full rounded-md border border-border object-contain"
              />
              <button
                type="button"
                aria-label="Remove screenshot"
                onClick={clearScreenshot}
                className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-surface-raised border border-border text-ink/55 shadow-sm transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                <X size={10} strokeWidth={2.2} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={isPending}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] text-ink/65 transition-colors hover:bg-surface-muted hover:text-ink disabled:opacity-60 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              <ImagePlus size={13} strokeWidth={1.8} />
              Attach screenshot
            </button>
          )}

          <input
            ref={fileInputRef}
            type="file"
            name="screenshot"
            accept={SCREENSHOT_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            onChange={handleScreenshotChange}
          />

          {screenshotError && <p className="text-[12px] text-danger">{screenshotError}</p>}
        </div>

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
          disabled={isPending}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <Send size={13} strokeWidth={1.9} />
          {isPending ? "Sending..." : "Send"}
        </button>
      </div>
    </form>
  );
}

export default function FeedbackDialog({ open, onClose }: Props) {
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
    >
      <FeedbackForm onClose={onClose} />
    </div>
  );
}
