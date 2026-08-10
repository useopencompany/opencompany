"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { MessageSquarePlus, Send, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { submitGoatFeedback } from "@/lib/feedback/actions";

// Feedback sits in the middle and is the default, so the most common report is the
// resting state and one tap reaches Bug or Idea.
const KIND_OPTIONS = [
  { value: "bug", label: "Bug" },
  { value: "feedback", label: "Feedback" },
  { value: "idea", label: "Idea" },
] as const;

type GoatFeedbackKind = (typeof KIND_OPTIONS)[number]["value"];
const DEFAULT_KIND: GoatFeedbackKind = "feedback";

// Sends the report the dialog has already optimistically confirmed. Runs
// fire-and-forget: by the time this resolves the dialog is gone, so a failure
// surfaces as an error toast whose Retry re-sends the same FormData.
async function sendFeedbackInBackground(formData: FormData) {
  try {
    const result = await submitGoatFeedback(null, formData);
    if (!result.ok) throw new Error(result.error);
  } catch (error) {
    toast.error("Couldn't send feedback", {
      description:
        error instanceof Error ? error.message : "Something went wrong. Please try again.",
      action: {
        label: "Retry",
        onClick: () => {
          void sendFeedbackInBackground(formData);
        },
      },
    });
  }
}

function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const [kind, setKind] = useState<GoatFeedbackKind>(DEFAULT_KIND);
  const [error, setError] = useState<string | null>(null);

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

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // Mirror the server's bounds so we never optimistically close on input the send would reject.
      const message = messageRef.current?.value.trim() ?? "";
      if (message.length < 3) {
        setError("Enter a bit more detail.");
        return;
      }
      if (message.length > 4000) {
        setError("Keep feedback under 4,000 characters.");
        return;
      }
      // Snapshot the form before this dialog unmounts, then hand it off. The
      // toast (rooted at the app shell) survives to report the outcome.
      const formData = new FormData(event.currentTarget);
      toast.success("Feedback sent");
      void sendFeedbackInBackground(formData);
      onClose();
    },
    [onClose],
  );

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/20 px-4 py-8 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="goat-feedback-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-[460px] overflow-hidden rounded-lg border border-border bg-surface shadow-[0_24px_64px_rgba(0,0,0,0.2),0_4px_14px_rgba(0,0,0,0.1)]"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id="goat-feedback-title" className="text-[14px] font-semibold text-ink">
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
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
              Type
            </span>
            <div
              role="radiogroup"
              aria-label="Feedback type"
              className="grid grid-cols-3 gap-0.5 rounded-lg border border-border bg-surface-subtle p-0.5"
            >
              {KIND_OPTIONS.map((option) => {
                const selected = kind === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setKind(option.value)}
                    className={`flex h-[30px] items-center justify-center rounded-md border text-[13px] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
                      selected
                        ? "border-border bg-surface font-semibold text-ink shadow-[0_1px_2px_rgba(0,0,0,0.10)]"
                        : "border-transparent font-medium text-ink-muted hover:text-ink"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <input type="hidden" name="kind" value={kind} />
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
              Feedback
            </span>
            <textarea
              ref={messageRef}
              name="message"
              rows={7}
              minLength={3}
              maxLength={4000}
              onChange={() => setError(null)}
              placeholder="Tell us what happened, what you expected, or what you'd like to see."
              className="min-h-[140px] resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-[13px] leading-5 text-ink outline-none transition-colors placeholder:text-ink/35 focus:border-ink/30 focus:ring-1 focus:ring-ink/15"
            />
          </label>

          {error ? (
            <div className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-[12.5px] text-danger">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors hover:bg-ink/85 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <Send size={13} strokeWidth={1.9} />
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

export function GoatSidebarFeedback() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-left text-[13px] text-ink/90 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <MessageSquarePlus
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-ink/60 group-hover:text-ink/80"
        />
        <span className="truncate tracking-[-0.005em]">Feedback</span>
      </button>
      {open ? <FeedbackDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}
