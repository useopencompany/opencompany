"use client";

import { ArrowLeft, ChartColumn, ChartLine, Hash, Loader2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useToast } from "@/components/ToastProvider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createKpiCard } from "@/lib/kpis/actions";
import type { KpiProviderPayload } from "@/lib/kpis/payload";
import { KPI_TIME_RANGES, type KpiCatalogEntry } from "@/lib/kpis/types";

type Viz = "number" | "bar" | "line";

const VIZ_OPTIONS: Array<{ value: Viz; label: string; icon: typeof Hash }> = [
  { value: "number", label: "Number", icon: Hash },
  { value: "bar", label: "Bar", icon: ChartColumn },
  { value: "line", label: "Line", icon: ChartLine },
];

const RANGE_LABELS: Record<number, string> = {
  1: "Today",
  7: "Last 7 days",
  30: "Last 30 days",
  90: "Last 90 days",
};

/**
 * Click-together flow: pick a connected provider, pick a prebuilt metric from
 * its catalog, tweak title/viz/horizon, add. Everything is driven by the
 * provider registry's catalog — no per-metric UI code.
 *
 * Mounted only while open (the parent conditionally renders it), so each
 * opening starts back at the provider step with fresh state.
 */
export function AddKpiDialog({
  onClose,
  providers,
}: {
  onClose: () => void;
  providers: KpiProviderPayload[];
}) {
  const { showError } = useToast();
  const [provider, setProvider] = useState<KpiProviderPayload | null>(null);
  const [entry, setEntry] = useState<KpiCatalogEntry | null>(null);
  const [title, setTitle] = useState("");
  const [viz, setViz] = useState<Viz>("number");
  const [rangeDays, setRangeDays] = useState<number>(7);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function selectEntry(selectedProvider: KpiProviderPayload, selectedEntry: KpiCatalogEntry) {
    setProvider(selectedProvider);
    setEntry(selectedEntry);
    setTitle(selectedEntry.label);
    setViz(selectedEntry.defaultViz);
    setRangeDays(selectedEntry.defaultTimeRangeDays);
    setConfig(
      Object.fromEntries(
        (selectedEntry.configFields ?? []).map((field) => [field.key, field.defaultValue ?? ""]),
      ),
    );
  }

  function handleCreate() {
    if (!provider || !entry) return;
    startTransition(async () => {
      try {
        const result = await createKpiCard({
          provider: provider.id,
          metricKey: entry.key,
          title,
          viz,
          timeRangeDays: rangeDays,
          config,
        });
        if (!result.ok) {
          showError(result.error, "Could not add KPI");
          return;
        }
        onClose();
      } catch (err) {
        showError(err instanceof Error ? err.message : "Could not add KPI", "Could not add KPI");
      }
    });
  }

  const step: "provider" | "configure" = entry ? "configure" : "provider";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add KPI"
      className="fixed inset-0 z-[80] flex items-start justify-center bg-ink/20 px-4 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="w-full max-w-[440px] rounded-xl border border-border bg-surface shadow-[0_24px_64px_rgba(0,0,0,0.18)]">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
          {step === "configure" && (
            <button
              type="button"
              aria-label="Back"
              onClick={() => setEntry(null)}
              className="-ml-1 rounded-md p-1 text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
            >
              <ArrowLeft size={14} strokeWidth={1.8} />
            </button>
          )}
          <h2 className="flex-1 text-[13.5px] font-medium text-ink">
            {step === "provider" ? "Add KPI" : (provider?.label ?? "Configure")}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mr-1 rounded-md p-1 text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        </div>

        {step === "provider" ? (
          <div className="flex flex-col gap-4 p-4">
            {providers.map((candidate) => (
              <div key={candidate.id}>
                <div className="flex items-baseline justify-between">
                  <p className="text-[12px] font-medium text-ink">{candidate.label}</p>
                  {!candidate.connected && (
                    <Link
                      href="/company/settings"
                      className="text-[11px] text-ink-subtle underline-offset-2 hover:text-ink hover:underline"
                    >
                      Connect in Settings
                    </Link>
                  )}
                </div>
                <div className="mt-1.5 flex flex-col gap-1">
                  {candidate.catalog.map((catalogEntry) => (
                    <button
                      key={catalogEntry.key}
                      type="button"
                      disabled={!candidate.connected}
                      onClick={() => selectEntry(candidate, catalogEntry)}
                      className="flex flex-col items-start rounded-md border border-border bg-surface px-3 py-2 text-left transition-colors duration-150 hover:border-border-strong hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="text-[12.5px] font-medium text-ink">
                        {catalogEntry.label}
                      </span>
                      <span className="mt-0.5 text-[11.5px] text-ink-muted">
                        {catalogEntry.description}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-4 p-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-[11.5px] font-medium text-ink-muted">Title</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={120}
                className="h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong focus:ring-2 focus:ring-ink/[0.04]"
              />
            </label>

            {(entry?.configFields ?? []).map((field) => (
              <label key={field.key} className="flex flex-col gap-1.5">
                <span className="text-[11.5px] font-medium text-ink-muted">{field.label}</span>
                <input
                  value={config[field.key] ?? ""}
                  onChange={(event) =>
                    setConfig((current) => ({ ...current, [field.key]: event.target.value }))
                  }
                  maxLength={field.maxLength ?? 240}
                  placeholder={field.placeholder}
                  className="h-8 rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong focus:ring-2 focus:ring-ink/[0.04]"
                />
                {field.description && (
                  <span className="text-[11.5px] leading-4 text-ink-subtle">
                    {field.description}
                  </span>
                )}
              </label>
            ))}

            <div className="flex flex-col gap-1.5">
              <span className="text-[11.5px] font-medium text-ink-muted">Visualization</span>
              <div className="flex gap-1">
                {VIZ_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={viz === option.value}
                    onClick={() => setViz(option.value)}
                    className={`flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border text-[12px] transition-colors duration-150 ${
                      viz === option.value
                        ? "border-border-strong bg-surface-active text-ink"
                        : "border-border bg-surface text-ink-muted hover:bg-surface-muted"
                    }`}
                  >
                    <option.icon size={13} strokeWidth={1.8} />
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-[11.5px] font-medium text-ink-muted">Time range</span>
              <Select
                value={String(rangeDays)}
                onValueChange={(value) => setRangeDays(Number(value))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KPI_TIME_RANGES.map((days) => (
                    <SelectItem key={days} value={String(days)}>
                      {RANGE_LABELS[days]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <div className="mt-1 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-8 rounded-md px-3 text-[12.5px] text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={
                  isPending ||
                  !title.trim() ||
                  (entry?.configFields ?? []).some(
                    (field) => field.required && !config[field.key]?.trim(),
                  )
                }
                className="flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas transition-opacity duration-150 hover:opacity-90 disabled:opacity-55"
              >
                {isPending && <Loader2 size={12.5} strokeWidth={2} className="animate-spin" />}
                {isPending ? "Fetching data…" : "Add KPI"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
