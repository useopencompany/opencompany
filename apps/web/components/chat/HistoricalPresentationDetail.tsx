"use client";

export type HistoricalPresentationDetailController = {
  state: "idle" | "loading" | "loaded" | "error";
  error: string | null;
  load: () => Promise<void>;
};

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
