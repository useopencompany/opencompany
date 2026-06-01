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

  const elapsed = elapsedBetween(startedAtMs, now);

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
