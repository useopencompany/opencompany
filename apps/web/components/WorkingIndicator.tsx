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

export function WorkingIndicator() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div role="status" aria-live="polite" className="inline-flex items-center gap-1.5">
      <span className="thinking-shimmer text-[13px] font-medium">Thinking</span>
      <span className="text-[12px] tabular-nums text-ink-subtle">{formatElapsed(elapsed)}</span>
    </div>
  );
}
