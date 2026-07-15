import { AlertCircle, DatabaseZap } from "lucide-react";
import { GoatSettingsContent } from "@/components/GoatSettingsChrome";

export type GoatIngestionUsageData = {
  plan: "free" | "pro";
  used: number;
  limit: number;
  seatQuantity: number;
  perSeatAllowance: number;
  overageUnits: number;
  overageUsdMicros: number;
  pending: number;
  resetAt: string;
  providers: Array<{ provider: string; count: number }>;
  recent: Array<{
    id: string;
    provider: string;
    rawEventCount: number;
    status: "pending" | "consumed";
    createdAt: string;
  }>;
};

export function GoatIngestionUsagePanel({ data }: { data: GoatIngestionUsageData }) {
  const percent = data.limit > 0 ? Math.min(100, Math.round((data.used / data.limit) * 100)) : 0;
  return (
    <GoatSettingsContent
      title="Usage"
      description="Track the raw events ingested for this workspace."
    >
      {data.pending > 0 ? (
        <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12.5px] leading-5 text-ink">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span>
            You&apos;ve used your monthly allowance, so {data.pending} event
            {data.pending === 1 ? " is" : "s are"} paused. They resume oldest-first when the
            allowance resets {formatReset(data.resetAt)}
            {data.plan === "free"
              ? " — or sooner if the workspace upgrades to Pro."
              : " — or sooner once the workspace has credits to cover the overage."}
          </span>
        </div>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
              {data.plan === "pro" ? "Monthly Pro allowance" : "Monthly Free allowance"}
            </div>
            <div className="mt-1 text-[24px] font-semibold tracking-tight text-ink">
              {data.used}{" "}
              <span className="text-[14px] font-normal text-ink-subtle">
                of {data.limit.toLocaleString()}
              </span>
            </div>
            {data.plan === "pro" ? (
              <div className="mt-0.5 text-[11.5px] leading-4 text-ink-subtle">
                {data.perSeatAllowance.toLocaleString()} items × {data.seatQuantity} seat
                {data.seatQuantity === 1 ? "" : "s"}, pooled across the workspace
              </div>
            ) : null}
            {data.overageUnits > 0 ? (
              <div className="mt-0.5 text-[11.5px] leading-4 text-ink-subtle">
                Plus {data.overageUnits.toLocaleString()} overage item
                {data.overageUnits === 1 ? "" : "s"} ({formatUsdMicros(data.overageUsdMicros)} from
                credits)
              </div>
            ) : null}
          </div>
          <div className="text-right text-[11.5px] leading-4 text-ink-subtle">
            Resets {formatReset(data.resetAt)}
          </div>
        </div>
        <div
          className="h-2 overflow-hidden rounded-full bg-surface-muted"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-ink transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          By source
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
          <p className="text-[12.5px] text-ink-subtle">No ingestions in this allowance window.</p>
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

function formatUsdMicros(usdMicros: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(usdMicros / 1_000_000);
}

function formatReset(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function formatProvider(provider: string) {
  const labels: Record<string, string> = {
    "goat-chat": "OpenCompany chat",
    google_drive: "Google Drive",
    github: "GitHub",
    gmail: "Gmail",
    jamie: "Jamie",
    linear: "Linear",
    slack: "Slack",
    upload: "Uploads",
  };
  return labels[provider] ?? provider.replaceAll("_", " ");
}
