import type { GoatSpendBreakdownRow } from "@opencompany/db/goat-credits";
import { AlertCircle, DatabaseZap } from "lucide-react";
import Link from "next/link";
import { GoatSettingsContent } from "@/components/GoatSettingsChrome";

export type GoatUsageData = {
  breakdown: GoatSpendBreakdownRow[];
  ingestedThisMonth: number;
  pending: number;
  creditBalanceUsdMicros: number;
  providers: Array<{ provider: string; count: number }>;
  recent: Array<{
    id: string;
    provider: string;
    rawEventCount: number;
    status: "pending" | "consumed";
    createdAt: string;
  }>;
};

const CATEGORY_LABELS: Record<GoatSpendBreakdownRow["category"], string> = {
  chat: "Chat",
  ingestion: "Ingestion",
  capabilities: "Paid capabilities",
  other: "Other",
};

export function GoatUsagePanel({ data }: { data: GoatUsageData }) {
  const days = groupByDay(data.breakdown);
  const totalSpend = data.breakdown.reduce((sum, row) => sum + row.spendUsdMicros, 0);
  const totalProviderCost = data.breakdown.reduce((sum, row) => sum + row.providerCostUsdMicros, 0);
  return (
    <GoatSettingsContent
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

      <section className="grid gap-2 sm:grid-cols-3">
        <StatTile label="Spent (30 days)" value={formatUsdMicros(totalSpend)} />
        <StatTile label="Provider cost" value={formatUsdMicros(totalProviderCost)} />
        <StatTile label="Usage fee" value="$0.00" />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Daily spend
        </h2>
        {days.length ? (
          days.map((day) => (
            <div key={day.day} className="rounded-lg border border-border bg-canvas px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] font-medium text-ink">{formatDay(day.day)}</span>
                <span className="text-[13px] tabular-nums text-ink">
                  {formatUsdMicros(day.total)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                {day.rows.map((row) => (
                  <span
                    key={row.category}
                    className="text-[11.5px] leading-4 tabular-nums text-ink-subtle"
                  >
                    {CATEGORY_LABELS[row.category]}: {formatUsdMicros(row.spendUsdMicros)}
                    {" ("}
                    {formatUsdMicros(row.providerCostUsdMicros)} provider cost{")"}
                  </span>
                ))}
              </div>
            </div>
          ))
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
            <div key={item.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5">
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
    </GoatSettingsContent>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-canvas p-3">
      <div className="text-[11px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
        {label}
      </div>
      <div className="mt-1 text-[17px] font-semibold tracking-tight text-ink">{value}</div>
    </div>
  );
}

function groupByDay(rows: GoatSpendBreakdownRow[]) {
  const byDay = new Map<string, GoatSpendBreakdownRow[]>();
  for (const row of rows) {
    const entry = byDay.get(row.day);
    if (entry) entry.push(row);
    else byDay.set(row.day, [row]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([day, dayRows]) => ({
      day,
      rows: dayRows,
      total: dayRows.reduce((sum, row) => sum + row.spendUsdMicros, 0),
    }));
}

function formatUsdMicros(usdMicros: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(usdMicros / 1_000_000);
}

function formatDay(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function formatProvider(provider: string) {
  const labels: Record<string, string> = {
    "goat-chat": "OpenCompany chat",
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
