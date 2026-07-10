"use client";

import { useEffect, useState } from "react";
import { formatGoatChatDuration } from "@/lib/chat-timing";

const TIMER_TICK_MS = 100;

export function ThinkingIndicator({
  startedAtMs,
  label = "Goat is working",
}: {
  startedAtMs: number;
  label?: string;
}) {
  const durationMs = useElapsedDurationMs(startedAtMs);

  return (
    <div className="flex justify-start">
      <div
        role="status"
        aria-live="polite"
        aria-label={label}
        className="-ml-1 inline-flex items-center gap-2 rounded-md px-1 py-0.5 text-[12px] font-medium leading-5 text-ink-muted"
      >
        <ActivityGlyph />
        <span>{formatGoatChatDuration(durationMs)}</span>
      </div>
    </div>
  );
}

export function TurnDuration({ durationMs }: { durationMs: number }) {
  return (
    <div className="flex justify-start">
      <div
        aria-label={`Turn completed in ${formatGoatChatDuration(durationMs)}`}
        className="-ml-1 inline-flex items-center rounded-md px-1 py-0.5 text-[12px] font-medium leading-5 text-ink-muted"
      >
        <span>{formatGoatChatDuration(durationMs)}</span>
      </div>
    </div>
  );
}

function useElapsedDurationMs(startedAtMs: number) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), TIMER_TICK_MS);
    return () => window.clearInterval(interval);
  }, [startedAtMs]);

  return Math.max(0, nowMs - startedAtMs);
}

function ActivityGlyph() {
  return (
    <span
      aria-hidden="true"
      className="grid h-4 w-3 shrink-0 grid-cols-2 grid-rows-3 gap-[3px] py-[2px]"
    >
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <span
          key={index}
          className="size-[2px] rounded-full bg-current animate-[goat-timer-dot_1.2s_ease-in-out_infinite]"
          style={{ animationDelay: `${index * 120}ms` }}
        />
      ))}
    </span>
  );
}
