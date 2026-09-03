import type { BillingUsageDto } from "@opencompany/protocol";
import { AlertCircle, DatabaseZap } from "lucide-react";
import Link from "next/link";
import { SettingsContent } from "@/components/SettingsChrome";
import {
  formatUsdMicros,
  type SpendCategory,
  SpendChart,
  type SpendDay,
  type SpendSeries,
} from "@/components/SpendChart";

export type UsageData = BillingUsageDto;

const CATEGORY_ORDER: readonly SpendCategory[] = ["chat", "ingestion", "capabilities", "other"];

const CATEGORY_LABELS: Record<SpendCategory, string> = {
  chat: "Chat",
  ingestion: "Ingestion",
  capabilities: "Paid capabilities",
  other: "Other",
};

export function UsagePanel({ data }: { data: UsageData }) {
  const totalSpend = data.breakdown.reduce((sum, row) => sum + row.spendUsdMicros, 0);
  const totalProviderCost = data.breakdown.reduce((sum, row) => sum + row.providerCostUsdMicros, 0);
  const totalFee = data.breakdown.reduce((sum, row) => sum + row.platformFeeUsdMicros, 0);

  const days = buildDailySeries(data.breakdown);
  const series = buildSeries(data.breakdown);
  const avgPerDay = days.length ? totalSpend / days.length : 0;

  return (
    <SettingsContent
      title="Usage"
      description="What this workspace spent over the last 30 days at provider cost."
    >
      {data.pending > 0 ? (
        <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12.5px] leading-5 text-ink">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span>
            Ingestion is paused — {data.pending} event{data.pending === 1 ? " is" : "s are"}{" "}
            waiting.{" "}
            <Link href="/settings/workspace/billing" className="font-medium underline">
              Top up to resume
            </Link>
            ; paused work runs oldest-first as soon as the balance is positive.
          </span>
        </div>
      ) : null}

      <section className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Spent · last 30 days
        </span>
        <span className="text-[34px] font-semibold leading-none tracking-tight text-ink">
          {formatUsdMicros(totalSpend)}
        </span>
        <span className="text-[12.5px] text-ink-subtle">
          {formatUsdMicros(totalProviderCost)} provider cost · {formatUsdMicros(totalFee)} usage fee
          {days.length ? ` · ${formatUsdMicros(avgPerDay)}/day avg` : ""}
        </span>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Daily spend
        </h2>
        {days.length ? (
          <div className="rounded-xl border border-border bg-canvas p-4">
            <SpendChart days={days} series={series} />
          </div>
        ) : (
          <p className="text-[12.5px] text-ink-subtle">No spend in the last 30 days.</p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Ingestions by source ({data.ingestedThisMonth.toLocaleString()} this month)
        </h2>
        {data.providers.length ? (
          data.providers.map((provider) => (
            <div key={provider.provider} className="flex items-center gap-3 rounded-lg px-2 py-1.5">
              <DatabaseZap size={14} className="text-ink-subtle" />
              <span className="flex-1 text-[13px] text-ink">
                {formatProvider(provider.provider)}
              </span>
              <span className="text-[12px] tabular-nums text-ink-subtle">{provider.count}</span>
            </div>
          ))
        ) : (
          <p className="text-[12.5px] text-ink-subtle">No ingestions this month.</p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Recent activity
        </h2>
        {data.recent.length ? (
          data.recent.map((item) => (
            <div key={item.activityId} className="flex items-center gap-3 rounded-lg px-2 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-ink">{formatProvider(item.provider)}</span>
                <span className="block text-[11px] text-ink-subtle">
                  {new Date(item.createdAt).toLocaleString()}
                </span>
              </span>
              <span className="text-[11.5px] text-ink-subtle">
                {item.status === "pending"
                  ? "Paused"
                  : `${item.rawEventCount} event${item.rawEventCount === 1 ? "" : "s"}`}
              </span>
            </div>
          ))
        ) : (
          <p className="text-[12.5px] text-ink-subtle">No ingestion activity yet.</p>
        )}
      </section>
    </SettingsContent>
  );
}

// Collapse the breakdown into one contiguous column per calendar day (gaps filled with zero) so
// the chart reads as a continuous timeline rather than skipping days with no spend.
function buildDailySeries(rows: BillingUsageDto["breakdown"]): SpendDay[] {
  const byDay = new Map<string, SpendDay>();
  for (const row of rows) {
    let entry = byDay.get(row.day);
    if (!entry) {
      entry = { day: row.day, chat: 0, ingestion: 0, capabilities: 0, other: 0, total: 0 };
      byDay.set(row.day, entry);
    }
    entry[row.category] += row.spendUsdMicros;
    entry.total += row.spendUsdMicros;
  }
  if (byDay.size === 0) return [];

  const keys = [...byDay.keys()].sort();
  const start = new Date(`${keys[0]}T00:00:00.000Z`);
  const end = new Date(`${keys[keys.length - 1]}T00:00:00.000Z`);
  const out: SpendDay[] = [];
  for (let t = start.getTime(), guard = 0; t <= end.getTime() && guard < 400; t += 86_400_000) {
    const key = new Date(t).toISOString().slice(0, 10);
    out.push(
      byDay.get(key) ?? { day: key, chat: 0, ingestion: 0, capabilities: 0, other: 0, total: 0 },
    );
    guard += 1;
  }
  return out;
}

function buildSeries(rows: BillingUsageDto["breakdown"]): SpendSeries[] {
  return CATEGORY_ORDER.map((key) => ({
    key,
    label: CATEGORY_LABELS[key],
    total: rows.reduce((sum, row) => (row.category === key ? sum + row.spendUsdMicros : sum), 0),
  })).filter((s) => s.total > 0);
}

function formatProvider(provider: string) {
  const labels: Record<string, string> = {
    "goat-chat": "opencompany chat",
    google_drive: "Google Drive",
    github: "GitHub",
    gmail: "Gmail",
    hubspot: "HubSpot",
    attio: "Attio",
    jamie: "Jamie",
    linear: "Linear",
    slack: "Slack",
    upload: "Uploads",
  };
  return labels[provider] ?? provider.replaceAll("_", " ");
}
