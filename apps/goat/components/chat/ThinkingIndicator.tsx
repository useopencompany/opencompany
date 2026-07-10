"use client";

export function ThinkingIndicator({ label = "Thinking" }: { label?: string }) {
  return (
    <div className="flex justify-start">
      <div
        role="status"
        aria-live="polite"
        aria-label="Goat is thinking"
        className="rounded-2xl rounded-bl-md bg-surface-muted px-3 py-2"
      >
        <span className="inline-block animate-[goat-thinking-shimmer_1.45s_ease-in-out_infinite] bg-[linear-gradient(100deg,var(--color-ink-subtle)_0%,var(--color-ink)_45%,var(--color-ink-subtle)_90%)] bg-[length:220%_100%] bg-clip-text text-[13px] font-medium leading-5 text-transparent">
          {label}
        </span>
      </div>
    </div>
  );
}
