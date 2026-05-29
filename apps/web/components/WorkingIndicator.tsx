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
  return (
    <WorkingIndicatorTimer key={startedAt ?? "local"} startedAt={startedAt} thinking={thinking} />
  );
}

function WorkingIndicatorTimer({
  startedAt,
  thinking,
}: {
  startedAt?: string | undefined;
  thinking: boolean;
}) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const elapsed =
    startedAt === undefined ? elapsedBetween(mountedAt, now) : elapsedSince(startedAt, now);

  return (
    <div role="status" aria-live="polite" className="inline-flex items-center gap-1.5">
      {thinking ? <span className="thinking-shimmer text-[13px] font-medium">Thinking</span> : null}
      <span className="text-[12px] tabular-nums text-ink-subtle">{formatElapsed(elapsed)}</span>
    </div>
  );
}

function elapsedSince(startedAt: string | undefined, now: number) {
  const startMs = startedAt ? new Date(startedAt).getTime() : Number.NaN;
  if (!Number.isFinite(startMs)) return 0;
  return elapsedBetween(startMs, now);
}

function elapsedBetween(startMs: number, endMs: number) {
  return Math.max(0, Math.floor((endMs - startMs) / 1000));
}
