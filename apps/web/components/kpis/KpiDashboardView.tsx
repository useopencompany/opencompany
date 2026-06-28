"use client";

import { Activity, BarChart3, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { createKpiAction } from "@/lib/kpis/actions";
import type { KpiDashboardState } from "@/lib/kpis/data";

export function KpiDashboardView({ state }: { state: KpiDashboardState }) {
  const [addOpen, setAddOpen] = useState(false);

  return (
    <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[1040px] px-8 pb-24 pt-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">KPIs</h1>
            <p className="mt-1 max-w-[620px] text-[13px] leading-5 tracking-[-0.005em] text-ink-muted">
              Track live product metrics from connected data sources. PostHog is available in v1.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas hover:bg-ink/90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <Plus size={13} strokeWidth={2} />
            Add KPI
          </button>
        </div>

        {state.cards.length === 0 ? (
          <EmptyState hasPostHog={state.dataSources.length > 0} onAdd={() => setAddOpen(true)} />
        ) : (
          <section className="mt-7 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {state.cards.map((card) => (
              <KpiCard key={card.id} card={card} />
            ))}
          </section>
        )}
      </div>

      {addOpen ? <AddKpiDialog state={state} onClose={() => setAddOpen(false)} /> : null}
    </main>
  );
}

function EmptyState({ hasPostHog, onAdd }: { hasPostHog: boolean; onAdd: () => void }) {
  return (
    <section className="mt-8 rounded-lg border border-border bg-surface/65 p-8 text-center">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
        <BarChart3 size={18} strokeWidth={1.85} />
      </div>
      <h2 className="mt-4 text-[14px] font-semibold text-ink">No KPIs yet</h2>
      <p className="mx-auto mt-1 max-w-[420px] text-[12.5px] leading-5 text-ink-muted">
        {hasPostHog
          ? "Add a PostHog KPI to start building this workspace dashboard."
          : "Connect PostHog from Integrations, then add DAU, WAU, or Signups here."}
      </p>
      <div className="mt-5 flex justify-center gap-2">
        {hasPostHog ? (
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas hover:bg-ink/90"
          >
            <Plus size={13} strokeWidth={2} />
            Add KPI
          </button>
        ) : (
          <a
            href="/company/integrations"
            className="inline-flex h-8 items-center rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas hover:bg-ink/90"
          >
            Connect PostHog
          </a>
        )}
      </div>
    </section>
  );
}

function KpiCard({ card }: { card: KpiDashboardState["cards"][number] }) {
  const delta = computeDelta(card.current, card.previous);
  return (
    <section className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-[13.5px] font-semibold tracking-[-0.005em] text-ink">
            {card.displayName}
          </h2>
          <p className="mt-1 text-[11.5px] text-ink-subtle">{card.templateName}</p>
        </div>
        <span className="rounded-full border border-border bg-canvas px-2 py-0.5 text-[10.5px] font-medium uppercase text-ink-subtle">
          {card.timeGrain}
        </span>
      </div>

      <div className="mt-5 flex items-end justify-between gap-4">
        <div>
          <div className="text-[30px] font-semibold leading-none tracking-[-0.01em] text-ink">
            {card.current === null ? "..." : formatNumber(card.current)}
          </div>
          <div
            className={`mt-2 text-[12px] font-medium ${
              delta === null ? "text-ink-subtle" : delta >= 0 ? "text-emerald-700" : "text-red-700"
            }`}
          >
            {delta === null ? "No comparison" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`}
          </div>
        </div>
        <Sparkline points={card.points.map((point) => point.value)} />
      </div>

      {card.liveError || card.status === "fetch_failed" ? (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[11.5px] leading-4 text-red-800">
          {card.liveError ?? card.statusReason ?? "Stored evaluation failed."}
        </p>
      ) : null}
    </section>
  );
}

function AddKpiDialog({ state, onClose }: { state: KpiDashboardState; onClose: () => void }) {
  const [sourceId, setSourceId] = useState(state.dataSources[0]?.id ?? "");
  const [templateId, setTemplateId] = useState(state.templates[0]?.id ?? "");
  const template = useMemo(
    () => state.templates.find((item) => item.id === templateId) ?? state.templates[0],
    [state.templates, templateId],
  );
  const source = state.dataSources.find((item) => item.id === sourceId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 px-4 py-8">
      <section className="w-full max-w-[560px] rounded-lg border border-border bg-canvas p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Add KPI</h2>
            <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">
              Choose a connected PostHog source and a curated metric template.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle hover:bg-surface-hover hover:text-ink"
          >
            <X size={14} strokeWidth={1.9} />
          </button>
        </div>

        {state.dataSources.length === 0 ? (
          <div className="mt-5 rounded-md border border-border bg-surface/65 p-4">
            <p className="text-[12.5px] leading-5 text-ink-muted">
              PostHog is not connected as a KPI data source yet.
            </p>
            <a
              href="/company/integrations"
              className="mt-3 inline-flex h-8 items-center rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas"
            >
              Connect PostHog
            </a>
          </div>
        ) : (
          <form action={createKpiAction} className="mt-5 grid gap-4">
            <input type="hidden" name="provider" value="posthog" />
            <label className="grid gap-1.5">
              <span className="text-[12px] font-medium text-ink">PostHog source</span>
              <select
                name="sourceIntegrationId"
                value={sourceId}
                onChange={(event) => setSourceId(event.target.value)}
                className="h-9 rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none focus:ring-1 focus:ring-ink/20"
              >
                {state.dataSources.map((dataSource) => (
                  <option key={dataSource.id} value={dataSource.id}>
                    {dataSource.connectionLabel ?? dataSource.accountName ?? "PostHog"}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-1.5">
              <span className="text-[12px] font-medium text-ink">Template</span>
              <select
                name="templateId"
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
                className="h-9 rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none focus:ring-1 focus:ring-ink/20"
              >
                {state.templates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName}
                  </option>
                ))}
              </select>
              {template ? (
                <span className="text-[11.5px] leading-4 text-ink-muted">
                  {template.description}
                </span>
              ) : null}
            </label>

            {template ? (
              <label className="grid gap-1.5">
                <span className="text-[12px] font-medium text-ink">Time grain</span>
                <select
                  name="timeGrain"
                  defaultValue={template.defaultTimeGrain}
                  key={template.id}
                  className="h-9 rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none focus:ring-1 focus:ring-ink/20"
                >
                  {template.timeGrainOptions.map((grain) => (
                    <option key={grain} value={grain}>
                      {grain}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {template?.filterParamsSchema.map((field) => (
              <label key={field.id} className="grid gap-1.5">
                <span className="text-[12px] font-medium text-ink">{field.label}</span>
                <input
                  name={`filter.${field.id}`}
                  defaultValue={field.defaultValue}
                  placeholder={field.placeholder}
                  className="h-9 rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-subtle focus:ring-1 focus:ring-ink/20"
                />
                {field.description ? (
                  <span className="text-[11.5px] leading-4 text-ink-muted">
                    {field.description}
                  </span>
                ) : null}
              </label>
            ))}

            <label className="grid gap-1.5">
              <span className="text-[12px] font-medium text-ink">Name</span>
              <input
                name="displayName"
                defaultValue={template?.displayName}
                className="h-9 rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none focus:ring-1 focus:ring-ink/20"
              />
            </label>

            <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-4">
              <div className="min-w-0 text-[11.5px] text-ink-subtle">
                {source ? (source.connectionLabel ?? source.accountName ?? "PostHog") : ""}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-8 rounded-md border border-border px-3 text-[12.5px] font-medium text-ink-muted hover:bg-surface-hover"
                >
                  Cancel
                </button>
                <SubmitButton />
              </div>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

function SubmitButton() {
  const status = useFormStatus();
  return (
    <button
      type="submit"
      disabled={status.pending}
      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <Activity size={13} strokeWidth={2} />
      {status.pending ? "Saving" : "Save KPI"}
    </button>
  );
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) {
    return <div className="h-12 w-28 rounded-md border border-border-subtle bg-canvas" />;
  }
  const width = 112;
  const height = 48;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const path = points
    .map((value, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = height - ((value - min) / range) * (height - 8) - 4;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        points={path}
        className="text-ink"
      />
    </svg>
  );
}

function computeDelta(current: number | null, previous: number | null) {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}
