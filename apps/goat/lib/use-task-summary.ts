"use client";

import { useEffect, useState } from "react";

export type GoatTaskSummary = {
  cost: {
    hasRecordedCosts: boolean;
    totalCostUsdMicros: number;
  };
  durationMs: number | null;
};

type GoatTaskSummaryState = {
  requestKey: string;
  summary: GoatTaskSummary | null;
  error: Error | null;
};

export function useGoatTaskSummary(taskId: string, terminal: boolean) {
  const requestKey = `${taskId}:${terminal}`;
  const [state, setState] = useState<GoatTaskSummaryState | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/tasks/${encodeURIComponent(taskId)}/summary`, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.ok) return (await response.json()) as GoatTaskSummary;
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(
          typeof body?.error === "string" ? body.error : "Could not load task summary.",
        );
      })
      .then((summary) => {
        setState({ requestKey, summary, error: null });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({
          requestKey,
          summary: null,
          error: error instanceof Error ? error : new Error("Could not load task summary."),
        });
      });

    return () => controller.abort();
  }, [requestKey, taskId]);

  const current = state?.requestKey === requestKey ? state : null;
  return {
    summary: current?.summary ?? null,
    error: current?.error ?? null,
  };
}
