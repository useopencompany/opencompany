"use client";

import { ChevronRight, CreditCard, ExternalLink, Gift, WalletCards } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
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

function SessionChargeRow({ entry }: { entry: BillingData["recentSessionCharges"][number] }) {
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
          href={`/session/${entry.sessionId}`}
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
  onError,
}: {
  amountCents: number;
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
          const result = await createCreditCheckoutSession(amountCents);
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

function CustomTopUpForm({ onError }: { onError: (message: string | null) => void }) {
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
          const result = await createCreditCheckoutSession(amountCents);
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

export function BillingPanel({ billing }: { billing: BillingData }) {
  const router = useRouter();
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

        <div className="mt-4 flex flex-wrap gap-2">
          {TOP_UP_AMOUNTS_CENTS.map((amountCents) => (
            <div key={amountCents}>
              <TopUpButton amountCents={amountCents} onError={setCheckoutError} />
            </div>
          ))}
          <CustomTopUpForm onError={setCheckoutError} />
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
              <SessionChargeRow key={entry.sessionId} entry={entry} />
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
