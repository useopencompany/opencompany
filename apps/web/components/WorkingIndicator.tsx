"use client";

import { useEffect, useState } from "react";

export function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

export function WorkingIndicator({
  startedAt,
  thinking = true,
}: {
  startedAt?: string | undefined;
  thinking?: boolean;
}) {
  const [elapsed, setElapsed] = useState(() => elapsedSince(startedAt));

  useEffect(() => {
    setElapsed(elapsedSince(startedAt));
    const interval = setInterval(() => {
      setElapsed((previous) => (startedAt === undefined ? previous + 1 : elapsedSince(startedAt)));
    }, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);

  return (
    <div role="status" aria-live="polite" className="inline-flex items-center gap-1.5">
      {thinking ? <span className="thinking-shimmer text-[13px] font-medium">Thinking</span> : null}
      <span className="text-[12px] tabular-nums text-ink-subtle">{formatElapsed(elapsed)}</span>
    </div>
  );
}

function elapsedSince(startedAt: string | undefined) {
  const startMs = startedAt ? new Date(startedAt).getTime() : Number.NaN;
  if (!Number.isFinite(startMs)) return 0;
  return Math.max(0, Math.floor((Date.now() - startMs) / 1000));
}
