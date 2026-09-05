"use client";

import { useEffect } from "react";

export type HistoricalPresentationDetailController = {
  state: "idle" | "loading" | "loaded" | "error";
  error: string | null;
  load: () => Promise<void>;
};

export function useHistoricalPresentationDetail(
  expanded: boolean,
  detail: HistoricalPresentationDetailController | undefined,
) {
  const state = detail?.state;
  const load = detail?.load;

  useEffect(() => {
    // A live row can stay expanded while Electric replaces it with a summary-backed revision.
    // In that case there is no second disclosure click to start the historical-detail request.
    if (expanded && state === "idle") void load?.();
  }, [expanded, load, state]);
}

export function HistoricalPresentationDetailStatus({
  detail,
}: {
  detail: HistoricalPresentationDetailController;
}) {
  if (detail.state === "loaded") return null;
  if (detail.state === "error") {
    return (
      <div className="flex items-center gap-2 py-1 text-[11px] text-danger" role="alert">
        <span>{detail.error ?? "Could not load this trace."}</span>
        <button
          type="button"
          onClick={() => void detail.load()}
          className="rounded-md border border-border px-1.5 py-0.5 font-medium text-ink-muted hover:bg-surface-hover"
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <div className="py-1 text-[11px] text-ink-subtle" role="status">
      Loading details…
    </div>
  );
}
