"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

/**
 * Returns a live elapsed-seconds counter that starts from the given ISO timestamp
 * (or from mount time if none is provided). The value is recomputed every second.
 * The same "take the earliest known start" semantics as WorkingIndicator apply:
 * if a server timestamp arrives later and is earlier than the local mount time,
 * the counter corrects upward; it never resets backward.
 */
export function useElapsedSeconds(startedAt?: string | undefined): number {
  const [mountedAtMs] = useState(() => Date.now());
  const parsedStartedAtMs = useMemo(() => parseTimestamp(startedAt), [startedAt]);
  const [trackedStart, setTrackedStart] = useState(() =>
    buildTrackedStart(startedAt, mountedAtMs, parsedStartedAtMs),
  );
  let startedAtMs = trackedStart.startedAtMs;
  if (trackedStart.startedAt !== startedAt) {
    const nextTrackedStart = buildTrackedStart(
      startedAt,
      trackedStart.startedAtMs,
      parsedStartedAtMs,
    );
    startedAtMs = nextTrackedStart.startedAtMs;
    setTrackedStart(nextTrackedStart);
  }
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return elapsedBetween(startedAtMs, now);
}

export function WorkingIndicator({
  startedAt,
  thinking = true,
}: {
  startedAt?: string | undefined;
  thinking?: boolean;
}) {
  return <WorkingIndicatorTimer startedAt={startedAt} thinking={thinking} />;
}

function WorkingIndicatorTimer({
  startedAt,
  thinking,
}: {
  startedAt?: string | undefined;
  thinking: boolean;
}) {
  const elapsed = useElapsedSeconds(startedAt);

  return (
    <div role="status" aria-live="polite" className="inline-flex items-center gap-1.5">
      {thinking ? <span className="thinking-shimmer text-[13px] font-medium">Thinking</span> : null}
      <LoaderCircle
        aria-hidden="true"
        size={13}
        strokeWidth={1.9}
        className="shrink-0 text-ink-subtle motion-safe:animate-spin"
      />
      <span className="text-[12px] tabular-nums text-ink-subtle">{formatElapsed(elapsed)}</span>
    </div>
  );
}

function parseTimestamp(value: string | undefined) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function buildTrackedStart(
  startedAt: string | undefined,
  earliestStartedAtMs: number,
  parsedStartedAtMs: number | null,
) {
  return {
    startedAt,
    startedAtMs:
      parsedStartedAtMs === null
        ? earliestStartedAtMs
        : Math.min(earliestStartedAtMs, parsedStartedAtMs),
  };
}

function elapsedBetween(startMs: number, endMs: number) {
  return Math.max(0, Math.floor((endMs - startMs) / 1000));
}
