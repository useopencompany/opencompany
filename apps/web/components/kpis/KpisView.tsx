"use client";

import { useLiveQuery } from "@tanstack/react-db";
import { ChartNoAxesColumn, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useCollections } from "@/components/CollectionsProvider";
import { AddKpiDialog } from "@/components/kpis/AddKpiDialog";
import { type KpiCardActions, KpiCardItem } from "@/components/kpis/KpiCardItem";
import { useHydrated } from "@/components/useHydrated";
import {
  type KpiBoardPayload,
  type KpiProviderPayload,
  kpiCardRowToPayload,
  kpiDatapointRowsToSeries,
  sortKpiCards,
} from "@/lib/kpis/payload";

export default function KpisView({
  initialBoard,
  providers,
}: {
  initialBoard?: KpiBoardPayload;
  providers: KpiProviderPayload[];
}) {
  const hydrated = useHydrated();

  // SSR + first client render: server data only, so hydration markup matches.
  if (!hydrated) {
    if (!initialBoard) return <KpisSkeleton />;
    return <KpisViewContent board={initialBoard} providers={providers} />;
  }
  return <KpisViewLive initialBoard={initialBoard} providers={providers} />;
}

// Client-only: useLiveQuery must not render during SSR (gated by useHydrated above).
function KpisViewLive({
  initialBoard,
  providers,
}: {
  initialBoard?: KpiBoardPayload | undefined;
  providers: KpiProviderPayload[];
}) {
  const { kpiCards, kpiMetrics, kpiDatapoints } = useCollections();
  const cardsQuery = useLiveQuery((q) => q.from({ card: kpiCards }));
  const metricsQuery = useLiveQuery((q) => q.from({ metric: kpiMetrics }));
  const datapointsQuery = useLiveQuery((q) => q.from({ datapoint: kpiDatapoints }));

  const liveBoard = useMemo<KpiBoardPayload>(() => {
    const metricsById = new Map((metricsQuery.data ?? []).map((row) => [row.id, row]));
    const cards = sortKpiCards(
      (cardsQuery.data ?? [])
        .map((row) => kpiCardRowToPayload(row, metricsById.get(row.metric_id)))
        .filter((card): card is NonNullable<typeof card> => card !== null),
    );
    return { cards, series: kpiDatapointRowsToSeries(datapointsQuery.data ?? []) };
  }, [cardsQuery.data, metricsQuery.data, datapointsQuery.data]);

  const isLoading = cardsQuery.isLoading || metricsQuery.isLoading || datapointsQuery.isLoading;
  if (isLoading && !initialBoard) return <KpisSkeleton />;
  const board = isLoading && initialBoard ? initialBoard : liveBoard;

  const actions: KpiCardActions = {
    // Optimistic: the collection applies the change locally, the handler
    // persists via server action and reconciles on the returned txid.
    changeRange: (cardId, days) => {
      kpiCards.update(cardId, (draft) => {
        draft.time_range_days = days;
      });
    },
    remove: (cardId) => {
      kpiCards.delete(cardId);
    },
  };

  return <KpisViewContent board={board} providers={providers} actions={actions} />;
}

function KpisViewContent({
  board,
  providers,
  actions,
}: {
  board: KpiBoardPayload;
  providers: KpiProviderPayload[];
  actions?: KpiCardActions | undefined;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const isEmpty = board.cards.length === 0;
  const hasConnectableProvider = providers.some((provider) => provider.connected);

  return (
    <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[960px] px-6 pb-16 pt-10">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">KPIs</h1>
            <p className="mt-1 text-[13px] tracking-[-0.005em] text-ink-muted">
              One place for the numbers that matter — pulled from your connected tools and kept
              fresh automatically.
            </p>
          </div>
          {!isEmpty && <AddKpiButton onClick={() => setAddOpen(true)} />}
        </div>

        {isEmpty ? (
          <div className="mt-12 flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface/50 px-6 py-16 text-center">
            <ChartNoAxesColumn size={20} strokeWidth={1.7} className="text-ink-subtle" />
            <p className="mt-3 text-[13.5px] font-medium text-ink">No KPIs yet</p>
            <p className="mt-1 max-w-[360px] text-[12.5px] text-ink-muted">
              {hasConnectableProvider
                ? "Add your first card — open PRs from GitHub, new issues from Linear, weekly active users from PostHog."
                : "Connect GitHub, Linear, or PostHog in Settings, then click your first KPIs together here."}
            </p>
            <div className="mt-5">
              <AddKpiButton onClick={() => setAddOpen(true)} label="Add your first KPI" />
            </div>
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {board.cards.map((card) => (
              <KpiCardItem
                key={card.id}
                card={card}
                points={board.series[card.metric.id] ?? []}
                actions={actions}
              />
            ))}
          </div>
        )}
      </div>

      {addOpen && <AddKpiDialog onClose={() => setAddOpen(false)} providers={providers} />}
    </main>
  );
}

function AddKpiButton({ onClick, label = "Add KPI" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas transition-opacity duration-150 hover:opacity-90"
    >
      <Plus size={13} strokeWidth={2} />
      {label}
    </button>
  );
}

function KpisSkeleton() {
  return (
    <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[960px] px-6 pb-16 pt-10">
        <div className="h-5 w-16 animate-pulse rounded bg-surface-subtle" />
        <div className="mt-2 h-4 w-72 animate-pulse rounded bg-surface-subtle" />
        <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <div key={index} className="h-[168px] animate-pulse rounded-lg bg-surface-subtle" />
          ))}
        </div>
      </div>
    </main>
  );
}
