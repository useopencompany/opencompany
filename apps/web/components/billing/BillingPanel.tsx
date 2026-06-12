"use client";

import { ChevronRight, CreditCard, ExternalLink, Gift, WalletCards } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { createCreditCheckoutSession, redeemCreditCode } from "@/lib/billing/actions";
import {
  isValidTopUpAmountCents,
  MAX_TOP_UP_AMOUNT_CENTS,
  MIN_TOP_UP_AMOUNT_CENTS,
  TOP_UP_AMOUNTS_CENTS,
} from "@/lib/billing/constants";

// Serialized billing overview (dates as ISO strings) shared by the workspace and personal settings
// surfaces. Mirrors loadBillingOverview's shape after createdAt is stringified at the route.
export type BillingData = {
  balanceUsdMicros: number;
  spendLast7UsdMicros: number;
  spendLast30UsdMicros: number;
  dailySpend: Array<{
    date: string;
    totalUsdMicros: number;
    modelUsdMicros: number;
    toolUsdMicros: number;
    computeUsdMicros: number;
    platformFeeUsdMicros: number;
  }>;
  recentSessionCharges: Array<{
    sessionId: string;
    title: string;
    agentName: string;
    totalUsdMicros: number;
    modelCostUsdMicros: number;
    toolCostUsdMicros: number;
    sandboxCostUsdMicros: number;
    providerCostUsdMicros: number;
    platformFeeUsdMicros: number;
    createdAt: string;
  }>;
  ledger: Array<{
    id: number;
    amountCents: number;
    amountUsdMicros: number;
    source: string;
    sessionId: string | null;
    providerCostUsdMicros: number;
    platformFeeUsdMicros: number;
    createdAt: string;
    costBasis: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }>;
};

const FORMAT_LOCALE = "en-US";
const FORMAT_TIME_ZONE = "UTC";

function formatUsd(cents: number) {
  return new Intl.NumberFormat(FORMAT_LOCALE, {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function formatUsdMicros(micros: number) {
  const roundedCents = Math.round(micros / 10_000);
  const cents = roundedCents === 0 ? 0 : roundedCents;
  return new Intl.NumberFormat(FORMAT_LOCALE, {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(FORMAT_LOCALE, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: FORMAT_TIME_ZONE,
  }).format(new Date(value));
}

function formatDay(value: string) {
  return new Intl.DateTimeFormat(FORMAT_LOCALE, {
    month: "short",
    day: "numeric",
    timeZone: FORMAT_TIME_ZONE,
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function shortSessionId(sessionId: string) {
  if (sessionId.length <= 16) return sessionId;
  return `${sessionId.slice(0, 8)}...${sessionId.slice(-5)}`;
}

function ledgerLabel(source: string) {
  if (source === "signup_bonus") return "Signup credit";
  if (source === "stripe_checkout") return "Credit top-up";
  if (source === "credit_code") return "Redeemed code";
  if (source === "model_usage") return "Model usage";
  if (source === "tool_usage") return "Tool usage";
  if (source === "sandbox_usage") return "Sandbox compute";
  if (source === "usage") return "Usage";
  return "Credit event";
}

function CostLine({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-ink-muted">{label}</span>
      <span className="font-medium text-ink">{formatUsdMicros(value)}</span>
    </div>
  );
}

const spendChartSegments = [
  {
    key: "modelUsdMicros",
    label: "Model usage",
    color: "var(--color-info)",
  },
  {
    key: "computeUsdMicros",
    label: "Compute",
    color: "var(--color-success)",
  },
  {
    key: "toolUsdMicros",
    label: "Tools",
    color: "var(--color-warning)",
  },
  {
    key: "platformFeeUsdMicros",
    label: "Platform fee",
    color: "var(--color-accent)",
  },
] as const;

function SpendChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{
    color?: string;
    dataKey?: string | number;
    value?: number | string;
  }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;

  const rows = payload
    .map((entry) => {
      const segment = spendChartSegments.find((item) => item.key === entry.dataKey);
      const value =
        typeof entry.value === "number" ? entry.value : Number.parseFloat(String(entry.value ?? 0));
      return segment ? { ...segment, value } : null;
    })
    .filter((entry): entry is (typeof spendChartSegments)[number] & { value: number } =>
      Boolean(entry),
    )
    .reverse();
  const total = rows.reduce((sum, row) => sum + row.value, 0);

  return (
    <div className="min-w-[168px] rounded-lg border border-border bg-surface px-3 py-2 text-[12px] shadow-[0_8px_24px_rgba(15,15,15,0.12)]">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="font-medium text-ink">
          {typeof label === "string" ? formatDay(label) : label}
        </span>
        <span className="font-medium text-ink">{formatUsdMicros(total)}</span>
      </div>
      <div className="space-y-1">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-4 text-ink-muted">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: row.color }}
              />
              <span className="truncate">{row.label}</span>
            </span>
            <span className="shrink-0 text-ink">{formatUsdMicros(row.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DailySpendChart({ data }: { data: BillingData["dailySpend"] }) {
  const hasSpend = data.some((entry) => entry.totalUsdMicros > 0);

  return (
    <div className="mt-4 border-t border-border-subtle pt-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
          Daily spend
        </div>
        <div className="text-[12px] font-medium text-ink">
          {formatUsdMicros(data.reduce((sum, entry) => sum + entry.totalUsdMicros, 0))}
        </div>
      </div>

      {hasSpend ? (
        <>
          <div className="h-[160px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                accessibilityLayer
                data={data}
                margin={{ top: 4, right: 0, left: 0, bottom: 0 }}
                barCategoryGap={10}
              >
                <CartesianGrid vertical={false} stroke="var(--color-border-subtle)" />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDay}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={4}
                  stroke="var(--color-ink-subtle)"
                  fontSize={11}
                />
                <YAxis hide domain={[0, "dataMax"]} />
                <Tooltip
                  content={<SpendChartTooltip />}
                  cursor={{ fill: "var(--color-surface-muted)" }}
                />
                {spendChartSegments.map((segment) => (
                  <Bar
                    key={segment.key}
                    dataKey={segment.key}
                    stackId="daily-spend"
                    fill={segment.color}
                    radius={segment.key === "platformFeeUsdMicros" ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5">
            {spendChartSegments.map((segment) => (
              <div
                key={segment.key}
                className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-muted"
              >
                <span
                  className="h-2 w-2 rounded-[2px]"
                  style={{ backgroundColor: segment.color }}
                  aria-hidden
                />
                {segment.label}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="rounded-md border border-dashed border-border bg-surface/35 px-3 py-3 text-[12px] leading-5 text-ink-muted">
          No spend over the last 7 days.
        </div>
      )}
    </div>
  );
}

function SessionChargeRow({
  entry,
  sessionPathPrefix,
}: {
  entry: BillingData["recentSessionCharges"][number];
  sessionPathPrefix: string;
}) {
  const otherCostUsdMicros = Math.max(
    entry.totalUsdMicros -
      entry.modelCostUsdMicros -
      entry.toolCostUsdMicros -
      entry.sandboxCostUsdMicros,
    0,
  );

  return (
    <details className="group border-t border-border-subtle first:border-t-0">
      <summary className="grid cursor-pointer list-none grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 transition-colors hover:bg-surface/70 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={14}
          strokeWidth={1.9}
          className="text-ink-subtle transition-transform duration-150 group-open:rotate-90"
          aria-hidden
        />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-ink">{entry.title}</div>
          <div className="mt-0.5 truncate text-[11.5px] text-ink-subtle">
            {entry.agentName} ·{" "}
            <span title={entry.sessionId}>Session {shortSessionId(entry.sessionId)}</span> ·{" "}
            {formatDateTime(entry.createdAt)}
          </div>
        </div>
        <div className="shrink-0 text-[13px] font-medium text-ink">
          {formatUsdMicros(entry.totalUsdMicros)}
        </div>
      </summary>
      <div className="border-t border-border-subtle bg-surface/35 px-8 py-3">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
              Usage
            </div>
            <div className="space-y-1 text-[12px]">
              <CostLine label="Model usage" value={entry.modelCostUsdMicros} />
              <CostLine label="Tool usage" value={entry.toolCostUsdMicros} />
              <CostLine label="Sandbox compute" value={entry.sandboxCostUsdMicros} />
              {otherCostUsdMicros > 0 && (
                <CostLine label="Other usage" value={otherCostUsdMicros} />
              )}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
              Cost basis
            </div>
            <div className="space-y-1 text-[12px]">
              <CostLine label="Provider cost" value={entry.providerCostUsdMicros} />
              <CostLine label="Platform fee" value={entry.platformFeeUsdMicros} />
            </div>
          </div>
        </div>
        <Link
          href={`${sessionPathPrefix}/session/${entry.sessionId}`}
          className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink hover:text-ink"
        >
          Open session
          <ExternalLink size={12} strokeWidth={1.9} />
        </Link>
      </div>
    </details>
  );
}

function parseUsdAmountCents(value: string) {
  const normalized = value.trim();
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return null;

  const [dollars, cents = ""] = normalized.split(".");
  const amountCents = Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
  return isValidTopUpAmountCents(amountCents) ? amountCents : null;
}

function TopUpButton({
  amountCents,
  returnPath,
  onError,
}: {
  amountCents: number;
  returnPath: string;
  onError: (message: string | null) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const featured = amountCents === 2500;

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        onError(null);
        startTransition(async () => {
          const result = await createCreditCheckoutSession(amountCents, returnPath);
          if (result?.ok === false) {
            onError(result.error);
          }
        });
      }}
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
        featured
          ? "bg-ink text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] hover:bg-ink/85"
          : "border border-border bg-surface text-ink hover:bg-surface-muted"
      }`}
    >
      <CreditCard size={13} strokeWidth={1.9} />
      {isPending ? "Opening..." : formatUsd(amountCents)}
    </button>
  );
}

function CustomTopUpForm({
  returnPath,
  onError,
}: {
  returnPath: string;
  onError: (message: string | null) => void;
}) {
  const [amount, setAmount] = useState("");
  const [isPending, startTransition] = useTransition();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onError(null);

        const amountCents = parseUsdAmountCents(amount);
        if (amountCents === null) {
          onError(
            `Enter an amount from ${formatUsd(MIN_TOP_UP_AMOUNT_CENTS)} to ${formatUsd(
              MAX_TOP_UP_AMOUNT_CENTS,
            )}.`,
          );
          return;
        }

        startTransition(async () => {
          const result = await createCreditCheckoutSession(amountCents, returnPath);
          if (result?.ok === false) {
            onError(result.error);
          }
        });
      }}
      className="flex h-8 min-w-[184px] items-center rounded-md border border-border bg-surface transition-colors focus-within:border-ink/30 focus-within:ring-1 focus-within:ring-ink/15"
    >
      <span className="pl-2.5 text-[12.5px] text-ink-subtle">$</span>
      <input
        value={amount}
        onChange={(event) => {
          setAmount(event.target.value);
          onError(null);
        }}
        placeholder="Custom"
        inputMode="decimal"
        aria-label="Custom top-up amount in dollars"
        className="h-full min-w-0 flex-1 bg-transparent px-1.5 text-[12.5px] text-ink outline-none placeholder:text-ink-subtle"
      />
      <button
        type="submit"
        disabled={isPending || !amount.trim()}
        className="inline-flex h-full shrink-0 items-center gap-1.5 rounded-r-md border-l border-border px-2.5 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
      >
        <CreditCard size={13} strokeWidth={1.9} />
        {isPending ? "Opening..." : "Add"}
      </button>
    </form>
  );
}

export function BillingPanel({
  billing,
  sessionPathPrefix,
}: {
  billing: BillingData;
  // "/company" or "/personal" — the surface this panel is rendered on. Session
  // links and the Stripe checkout return path both depend on it.
  sessionPathPrefix: string;
}) {
  const router = useRouter();
  const settingsReturnPath = `${sessionPathPrefix}/settings`;
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
              <WalletCards size={15} strokeWidth={1.8} />
            </span>
            <div>
              <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">
                Current balance
              </div>
              <div className="mt-1 text-[28px] font-semibold leading-none tracking-[-0.015em] text-ink">
                {formatUsdMicros(billing.balanceUsdMicros)}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border-subtle pt-4">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
              7-day spend
            </div>
            <div className="mt-1 text-[14px] font-medium text-ink">
              {formatUsdMicros(billing.spendLast7UsdMicros)}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
              30-day spend
            </div>
            <div className="mt-1 text-[14px] font-medium text-ink">
              {formatUsdMicros(billing.spendLast30UsdMicros)}
            </div>
          </div>
        </div>

        <DailySpendChart data={billing.dailySpend} />

        <div className="mt-4 flex flex-wrap gap-2">
          {TOP_UP_AMOUNTS_CENTS.map((amountCents) => (
            <div key={amountCents}>
              <TopUpButton
                amountCents={amountCents}
                returnPath={settingsReturnPath}
                onError={setCheckoutError}
              />
            </div>
          ))}
          <CustomTopUpForm returnPath={settingsReturnPath} onError={setCheckoutError} />
        </div>
        {checkoutError && <div className="mt-2 text-[12px] text-danger">{checkoutError}</div>}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setMessage(null);
          startTransition(async () => {
            const result = await redeemCreditCode(code);
            if (result.ok) {
              setCode("");
              setMessage({
                type: "success",
                text: `${formatUsd(result.amountCents)} added to your workspace.`,
              });
              router.refresh();
              return;
            }
            setMessage({ type: "error", text: result.error });
          });
        }}
        className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
            <Gift size={15} strokeWidth={1.8} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">Redeem code</div>
            <div className="mt-3 flex items-center gap-2">
              <input
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                  setMessage(null);
                }}
                placeholder="Enter code"
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 text-[13px] uppercase text-ink outline-none transition-colors placeholder:normal-case placeholder:text-ink-subtle focus:border-ink/30 focus:ring-1 focus:ring-ink/15"
              />
              <button
                type="submit"
                disabled={isPending || !code.trim()}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isPending ? "Redeeming..." : "Redeem"}
              </button>
            </div>
            {message && (
              <div
                className={`mt-2 text-[12px] ${
                  message.type === "success" ? "text-success" : "text-danger"
                }`}
              >
                {message.text}
              </div>
            )}
          </div>
        </div>
      </form>

      <div>
        <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
          Recent session charges
        </div>
        {billing.recentSessionCharges.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-surface/35 px-3 py-3 text-[12px] leading-5 text-ink-muted">
            Session charges will appear here after agents run.
          </div>
        ) : (
          <div className="mb-4 overflow-hidden rounded-lg border border-border bg-surface/55">
            {billing.recentSessionCharges.map((entry) => (
              <SessionChargeRow
                key={entry.sessionId}
                entry={entry}
                sessionPathPrefix={sessionPathPrefix}
              />
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
          Recent activity
        </div>
        {billing.ledger.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-surface/35 px-3 py-3 text-[12px] leading-5 text-ink-muted">
            Billing activity will appear here.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-surface/55">
            {billing.ledger.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-4 border-t border-border-subtle px-3 py-2.5 first:border-t-0"
              >
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-ink">
                    {ledgerLabel(entry.source)}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-ink-subtle">
                    {formatDateTime(entry.createdAt)}
                  </div>
                </div>
                <div
                  className={`shrink-0 text-[13px] font-medium ${
                    entry.amountUsdMicros >= 0 ? "text-success" : "text-ink"
                  }`}
                >
                  {entry.amountUsdMicros >= 0 ? "+" : ""}
                  {formatUsdMicros(entry.amountUsdMicros)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
