"use client";

import {
  EXPERIMENT_DEFINITIONS,
  EXPERIMENT_KEYS,
  type ExperimentDefinition,
  type ExperimentKey,
  type WorkspaceExperiments,
} from "@opencompany/agent-runtime";
import {
  AlertTriangle,
  BarChart3,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  CreditCard,
  ExternalLink,
  FlaskConical,
  Gift,
  GitBranch,
  KeyRound,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  Plug,
  Sun,
  Trash2,
  WalletCards,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useRef, useState, useTransition } from "react";
import { type ThemeMode, useTheme } from "@/components/ThemeProvider";
import { ToolPolicyEditor } from "@/components/ToolPolicyEditor";
import { Toggle } from "@/components/ui/toggle";
import { createCreditCheckoutSession, redeemCreditCode } from "@/lib/billing/actions";
import {
  isValidTopUpAmountCents,
  MAX_TOP_UP_AMOUNT_CENTS,
  MIN_TOP_UP_AMOUNT_CENTS,
  TOP_UP_AMOUNTS_CENTS,
} from "@/lib/billing/constants";
import {
  removeLinearMcpToken,
  removePostHogMcpConnection,
  removeSlackMcpConnection,
  saveLinearMcpToken,
  setWorkspaceExperimentEnabled,
} from "@/lib/mcp/actions";
import type { WorkspaceToolPolicyOverrides } from "@/lib/tool-policies/data";
import { removeAvatar, updateAvatar } from "@/lib/users/actions";
import { updateWorkspaceName } from "@/lib/workspaces/actions";

const LINEAR_API_KEYS_URL = "https://linear.app/settings/account/security";
const LINEAR_MCP_DOCS_URL = "https://linear.app/docs/mcp";
const LINEAR_MCP_START_URL = "/api/mcp/linear/start?returnTo=/settings";
const SLACK_MCP_DOCS_URL = "https://docs.slack.dev/ai/slack-mcp-server/";
const SLACK_MCP_START_URL = "/api/mcp/slack/start?returnTo=/settings";
const POSTHOG_MCP_DOCS_URL = "https://posthog.com/docs/model-context-protocol";
const POSTHOG_MCP_START_URL = "/api/mcp/posthog/start?returnTo=/settings";
const SETTINGS_FORMAT_LOCALE = "en-US";
const SETTINGS_FORMAT_TIME_ZONE = "UTC";

type Props = {
  profile: {
    name: string;
    email: string;
    avatarUrl: string | null;
    hasCustomAvatar: boolean;
    initials: string;
  };
  workspace: {
    name: string;
    createdAt: string;
    sync: {
      hasRepo: boolean;
      lastSyncedAt: string | null;
      pendingCount: number;
      failedCount: number;
    };
  };
  billing: {
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
  mcp: {
    mcpEnabled: boolean;
    linear: {
      configured: boolean;
      status: "configured" | "missing_credential" | "disabled" | "error" | null;
      statusReason: string | null;
      updatedAt: string | null;
    };
    slack: {
      configured: boolean;
      status: "configured" | "missing_credential" | "disabled" | "error" | null;
      statusReason: string | null;
      updatedAt: string | null;
    };
    posthog: {
      configured: boolean;
      status: "configured" | "missing_credential" | "disabled" | "error" | null;
      statusReason: string | null;
      updatedAt: string | null;
    };
  };
  toolPolicies: WorkspaceToolPolicyOverrides;
  experiments: WorkspaceExperiments;
};

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-border-subtle py-7 first:border-t-0 first:pt-0">
      <div className="grid grid-cols-[200px_1fr] gap-8">
        <div>
          <h2 className="text-[13px] font-semibold tracking-[-0.005em] text-ink">{title}</h2>
          {description && (
            <p className="mt-1 text-[12px] leading-5 text-ink-muted">{description}</p>
          )}
        </div>
        <div className="flex flex-col gap-4">{children}</div>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
        {label}
      </div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function ReadOnly({ value }: { value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface/60 px-2.5 py-1.5 text-[13px] text-ink/85">
      {value}
    </div>
  );
}

const themeOptions: Array<{
  value: ThemeMode;
  label: string;
  icon: typeof Monitor;
}> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

function AppearanceSection() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      className="inline-flex w-fit rounded-lg border border-border bg-surface p-1 shadow-[0_1px_2px_rgba(15,15,15,0.03)]"
      role="radiogroup"
      aria-label="Theme"
    >
      {themeOptions.map((option) => {
        const Icon = option.icon;
        const selected = theme === option.value;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(option.value)}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
              selected
                ? "bg-surface-active text-ink shadow-[0_1px_1px_rgba(15,15,15,0.05)]"
                : "text-ink-muted hover:bg-surface-hover hover:text-ink"
            }`}
          >
            <Icon size={13} strokeWidth={1.9} />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function formatUsd(cents: number) {
  return new Intl.NumberFormat(SETTINGS_FORMAT_LOCALE, {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function formatUsdMicros(micros: number) {
  const roundedCents = Math.round(micros / 10_000);
  const cents = roundedCents === 0 ? 0 : roundedCents;
  return new Intl.NumberFormat(SETTINGS_FORMAT_LOCALE, {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(SETTINGS_FORMAT_LOCALE, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: SETTINGS_FORMAT_TIME_ZONE,
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

function SessionChargeRow({ entry }: { entry: Props["billing"]["recentSessionCharges"][number] }) {
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

function BillingSection({ billing }: { billing: Props["billing"] }) {
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

function WorkspaceState({ sync }: { sync: Props["workspace"]["sync"] }) {
  const failed = sync.failedCount > 0;
  const pending = sync.pendingCount > 0;

  return (
    <div className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
          <GitBranch size={15} strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">
            Managed by opencompany through Git
          </div>
          <p className="mt-1 text-[12px] leading-5 text-ink-muted">
            Your workspace files are versioned automatically in a private Git-backed repository.
          </p>

          <div className="mt-3 flex items-center gap-1.5 text-[12px]">
            {failed ? (
              <>
                <AlertTriangle size={13} strokeWidth={1.8} className="shrink-0 text-danger" />
                <span className="font-medium text-danger">
                  {sync.failedCount} change{sync.failedCount === 1 ? "" : "s"} failed to sync —
                  retrying
                </span>
              </>
            ) : pending ? (
              <>
                <Clock size={13} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
                <span className="text-ink-muted">
                  {sync.pendingCount} change{sync.pendingCount === 1 ? "" : "s"} waiting to sync
                </span>
              </>
            ) : (
              <>
                <CheckCircle2 size={13} strokeWidth={1.8} className="shrink-0 text-success" />
                <span className="text-ink-muted">In sync</span>
              </>
            )}
          </div>

          <div className="mt-3 text-[11.5px] text-ink-subtle">
            {sync.hasRepo
              ? sync.lastSyncedAt
                ? `Last synced ${sync.lastSyncedAt}`
                : "Not synced yet"
              : "Git storage is being set up"}
          </div>
        </div>
      </div>
    </div>
  );
}

function ExperimentsSection({
  mcp,
  toolPolicies,
  experiments,
}: {
  mcp: Props["mcp"];
  toolPolicies: WorkspaceToolPolicyOverrides;
  experiments: WorkspaceExperiments;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Optimistic per-experiment enabled state so toggles (and the MCP provider cards gated on the MCP
  // flag) flip instantly, before the server action + router.refresh round-trips.
  const [enabledByKey, setEnabledByKey] = useState<Record<ExperimentKey, boolean>>(
    () =>
      Object.fromEntries(
        EXPERIMENT_DEFINITIONS.map((definition) => [
          definition.key,
          experiments[definition.key] === true,
        ]),
      ) as Record<ExperimentKey, boolean>,
  );
  const linearSetupStatus = searchParams.get("mcp") === "linear" ? searchParams.get("setup") : null;
  const normalizedLinearSetupStatus =
    linearSetupStatus === "connected" || linearSetupStatus === "error" ? linearSetupStatus : null;
  const linearSetupReason =
    searchParams.get("mcp") === "linear" ? searchParams.get("reason") : null;
  const slackSetupStatus = searchParams.get("mcp") === "slack" ? searchParams.get("setup") : null;
  const normalizedSlackSetupStatus =
    slackSetupStatus === "connected" || slackSetupStatus === "error" ? slackSetupStatus : null;
  const slackSetupReason = searchParams.get("mcp") === "slack" ? searchParams.get("reason") : null;
  const posthogSetupStatus =
    searchParams.get("mcp") === "posthog" ? searchParams.get("setup") : null;
  const normalizedPosthogSetupStatus =
    posthogSetupStatus === "connected" || posthogSetupStatus === "error"
      ? posthogSetupStatus
      : null;
  const posthogSetupReason =
    searchParams.get("mcp") === "posthog" ? searchParams.get("reason") : null;

  return (
    <div className="space-y-3">
      {EXPERIMENT_DEFINITIONS.map((definition) => (
        <Fragment key={definition.key}>
          <ExperimentToggle
            definition={definition}
            enabled={enabledByKey[definition.key] ?? false}
            onChange={(next) => setEnabledByKey((prev) => ({ ...prev, [definition.key]: next }))}
            onSaved={() => router.refresh()}
          />
          {/* The MCP experiment has provider connection cards that only make sense once it is on. */}
          {definition.key === EXPERIMENT_KEYS.mcp && enabledByKey[EXPERIMENT_KEYS.mcp] === true ? (
            <>
              <LinearMcpCard
                linear={mcp.linear}
                setupStatus={normalizedLinearSetupStatus}
                setupReason={linearSetupReason}
                policyOverrides={toolPolicies.linear}
              />
              <SlackMcpCard
                slack={mcp.slack}
                setupStatus={normalizedSlackSetupStatus}
                setupReason={slackSetupReason}
                policyOverrides={toolPolicies.slack}
              />
              <PostHogMcpCard
                posthog={mcp.posthog}
                setupStatus={normalizedPosthogSetupStatus}
                setupReason={posthogSetupReason}
                policyOverrides={toolPolicies.posthog}
              />
            </>
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}

// A single workspace-experiment row: the flask card with its title/description and an On/Off toggle
// wired to the generic setWorkspaceExperimentEnabled action. Optimistic enabled state is owned by
// the parent so dependent UI (e.g. MCP provider cards) can react to it.
function ExperimentToggle({
  definition,
  enabled,
  onChange,
  onSaved,
}: {
  definition: ExperimentDefinition;
  enabled: boolean;
  onChange: (next: boolean) => void;
  onSaved: () => void;
}) {
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
            <FlaskConical size={15} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">
              {definition.title}
            </div>
            <p className="mt-1 text-[12px] leading-5 text-ink-muted">{definition.description}</p>
          </div>
        </div>
        <Toggle
          pressed={enabled}
          disabled={isPending}
          aria-label={`${enabled ? "Disable" : "Enable"} ${definition.title}`}
          onPressedChange={(next) => {
            onChange(next);
            setMessage(null);
            startTransition(async () => {
              const result = await setWorkspaceExperimentEnabled(definition.key, next);
              if (result.ok) {
                onSaved();
                return;
              }
              onChange(!next);
              setMessage({ type: "error", text: `Could not update ${definition.title}.` });
            });
          }}
          className="w-[74px]"
        >
          {enabled ? "On" : "Off"}
        </Toggle>
      </div>
      {message && (
        <div
          className={`mt-3 text-[12px] ${
            message.type === "success" ? "text-success" : "text-danger"
          }`}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}

function LinearMcpCard({
  linear,
  setupStatus,
  setupReason,
  policyOverrides,
}: {
  linear: Props["mcp"]["linear"];
  setupStatus: "connected" | "error" | null;
  setupReason: string | null;
  policyOverrides: WorkspaceToolPolicyOverrides[string] | undefined;
}) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [dismissedSetupStatus, setDismissedSetupStatus] = useState<"connected" | "error" | null>(
    null,
  );
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const configured = linear.configured;
  const setupMessage =
    setupStatus && setupStatus !== dismissedSetupStatus
      ? {
          type: setupStatus === "connected" ? ("success" as const) : ("error" as const),
          text:
            setupStatus === "connected"
              ? "Linear connected."
              : linearMcpSetupErrorMessage(setupReason),
        }
      : null;
  const visibleMessage = message ?? setupMessage;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setMessage(null);
        setDismissedSetupStatus(setupStatus);
        startTransition(async () => {
          const result = await saveLinearMcpToken(token);
          if (result.ok) {
            setToken("");
            setMessage({ type: "success", text: "Linear MCP token saved." });
            router.refresh();
            return;
          }
          setMessage({ type: "error", text: result.error });
        });
      }}
      className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
            <KeyRound size={15} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">Linear MCP</div>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${
                  configured
                    ? "border-success-border bg-success-bg text-success"
                    : "border-warning-border bg-warning-bg text-warning"
                }`}
              >
                {configured ? "Configured" : "Not connected"}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-5 text-ink-muted">
              Agents can opt in with @linear after Linear is connected.
            </p>
            {linear.statusReason ? (
              <p className="mt-1 text-[11.5px] leading-4 text-ink-subtle">{linear.statusReason}</p>
            ) : null}
          </div>
        </div>
        {configured ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              setMessage(null);
              setDismissedSetupStatus(setupStatus);
              startTransition(async () => {
                const result = await removeLinearMcpToken();
                if (result.ok) {
                  setMessage({ type: "success", text: "Linear MCP token removed." });
                  router.refresh();
                }
              });
            }}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={13} strokeWidth={1.9} />
            Remove
          </button>
        ) : null}
      </div>
      <div className="mt-4 border-t border-border-subtle pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={LINEAR_MCP_START_URL}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85"
          >
            <ExternalLink size={13} strokeWidth={1.9} />
            {configured ? "Reconnect Linear" : "Connect Linear"}
          </a>
          <a
            href={LINEAR_MCP_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-muted hover:text-ink"
          >
            MCP docs
            <ExternalLink size={12} strokeWidth={1.9} />
          </a>
        </div>
        <details className="mt-3">
          <summary className="cursor-pointer list-none text-[12px] font-medium text-ink-muted transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
            Use a Linear API key instead
          </summary>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <a
              href={LINEAR_API_KEYS_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted"
            >
              <ExternalLink size={13} strokeWidth={1.9} />
              Create Linear API key
            </a>
            <div className="flex min-w-[240px] flex-1 items-center gap-2">
              <input
                value={token}
                onChange={(event) => {
                  setToken(event.target.value);
                  setMessage(null);
                  setDismissedSetupStatus(setupStatus);
                }}
                placeholder={
                  configured ? "Paste a new token to replace it" : "Linear API key or OAuth token"
                }
                type="password"
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-ink/30 focus:ring-1 focus:ring-ink/15"
              />
              <button
                type="submit"
                disabled={isPending || !token.trim()}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isPending ? "Saving..." : configured ? "Replace" : "Save"}
              </button>
            </div>
          </div>
        </details>
      </div>
      {visibleMessage && (
        <div
          className={`mt-2 text-[12px] ${
            visibleMessage.type === "success" ? "text-success" : "text-danger"
          }`}
        >
          {visibleMessage.text}
        </div>
      )}
      {configured ? <ToolPolicyEditor providerKey="linear" overrides={policyOverrides} /> : null}
    </form>
  );
}

function SlackMcpCard({
  slack,
  setupStatus,
  setupReason,
  policyOverrides,
}: {
  slack: Props["mcp"]["slack"];
  setupStatus: "connected" | "error" | null;
  setupReason: string | null;
  policyOverrides: WorkspaceToolPolicyOverrides[string] | undefined;
}) {
  const router = useRouter();
  const [dismissedSetupStatus, setDismissedSetupStatus] = useState<"connected" | "error" | null>(
    null,
  );
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const configured = slack.configured;
  const setupMessage =
    setupStatus && setupStatus !== dismissedSetupStatus
      ? {
          type: setupStatus === "connected" ? ("success" as const) : ("error" as const),
          text:
            setupStatus === "connected"
              ? "Slack connected."
              : slackMcpSetupErrorMessage(setupReason),
        }
      : null;
  const visibleMessage = message ?? setupMessage;

  return (
    <div className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
            <MessageSquare size={15} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">Slack MCP</div>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${
                  configured
                    ? "border-success-border bg-success-bg text-success"
                    : "border-warning-border bg-warning-bg text-warning"
                }`}
              >
                {configured ? "Configured" : "Not connected"}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-5 text-ink-muted">
              Agents can opt in with @slack after Slack is connected.
            </p>
            {slack.statusReason ? (
              <p className="mt-1 text-[11.5px] leading-4 text-ink-subtle">{slack.statusReason}</p>
            ) : null}
          </div>
        </div>
        {configured ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              setMessage(null);
              setDismissedSetupStatus(setupStatus);
              startTransition(async () => {
                const result = await removeSlackMcpConnection();
                if (result.ok) {
                  setMessage({ type: "success", text: "Slack MCP connection removed." });
                  router.refresh();
                }
              });
            }}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={13} strokeWidth={1.9} />
            Remove
          </button>
        ) : null}
      </div>
      <div className="mt-4 border-t border-border-subtle pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={SLACK_MCP_START_URL}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85"
          >
            <ExternalLink size={13} strokeWidth={1.9} />
            {configured ? "Reconnect Slack" : "Connect Slack"}
          </a>
          <a
            href={SLACK_MCP_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-muted hover:text-ink"
          >
            MCP docs
            <ExternalLink size={12} strokeWidth={1.9} />
          </a>
        </div>
      </div>
      {visibleMessage && (
        <div
          className={`mt-2 text-[12px] ${
            visibleMessage.type === "success" ? "text-success" : "text-danger"
          }`}
        >
          {visibleMessage.text}
        </div>
      )}
      {configured ? <ToolPolicyEditor providerKey="slack" overrides={policyOverrides} /> : null}
    </div>
  );
}

function PostHogMcpCard({
  posthog,
  setupStatus,
  setupReason,
  policyOverrides,
}: {
  posthog: Props["mcp"]["posthog"];
  setupStatus: "connected" | "error" | null;
  setupReason: string | null;
  policyOverrides: WorkspaceToolPolicyOverrides[string] | undefined;
}) {
  const router = useRouter();
  const [dismissedSetupStatus, setDismissedSetupStatus] = useState<"connected" | "error" | null>(
    null,
  );
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const configured = posthog.configured;
  const setupMessage =
    setupStatus && setupStatus !== dismissedSetupStatus
      ? {
          type: setupStatus === "connected" ? ("success" as const) : ("error" as const),
          text:
            setupStatus === "connected"
              ? "PostHog connected."
              : posthogMcpSetupErrorMessage(setupReason),
        }
      : null;
  const visibleMessage = message ?? setupMessage;

  return (
    <div className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
            <BarChart3 size={15} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">
                PostHog MCP
              </div>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${
                  configured
                    ? "border-success-border bg-success-bg text-success"
                    : "border-warning-border bg-warning-bg text-warning"
                }`}
              >
                {configured ? "Configured" : "Not connected"}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-5 text-ink-muted">
              Agents can opt in with @posthog after PostHog is connected.
            </p>
            {posthog.statusReason ? (
              <p className="mt-1 text-[11.5px] leading-4 text-ink-subtle">{posthog.statusReason}</p>
            ) : null}
          </div>
        </div>
        {configured ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              setMessage(null);
              setDismissedSetupStatus(setupStatus);
              startTransition(async () => {
                const result = await removePostHogMcpConnection();
                if (result.ok) {
                  setMessage({ type: "success", text: "PostHog MCP connection removed." });
                  router.refresh();
                }
              });
            }}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={13} strokeWidth={1.9} />
            Remove
          </button>
        ) : null}
      </div>
      <div className="mt-4 border-t border-border-subtle pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={POSTHOG_MCP_START_URL}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85"
          >
            <ExternalLink size={13} strokeWidth={1.9} />
            {configured ? "Reconnect PostHog" : "Connect PostHog"}
          </a>
          <a
            href={POSTHOG_MCP_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-muted hover:text-ink"
          >
            MCP docs
            <ExternalLink size={12} strokeWidth={1.9} />
          </a>
        </div>
      </div>
      {visibleMessage && (
        <div
          className={`mt-2 text-[12px] ${
            visibleMessage.type === "success" ? "text-success" : "text-danger"
          }`}
        >
          {visibleMessage.text}
        </div>
      )}
      {configured ? <ToolPolicyEditor providerKey="posthog" overrides={policyOverrides} /> : null}
    </div>
  );
}

function linearMcpSetupErrorMessage(reason: string | null) {
  switch (reason) {
    case "invalid_state":
      return "Linear connection expired or was started in another browser tab. Try reconnecting Linear.";
    case "session_mismatch":
      return "Linear returned to a different OpenCompany session. Sign in to the same workspace and try again.";
    case "linear_denied":
      return "Linear did not authorize the connection.";
    case "missing_code":
      return "Linear did not return an authorization code. Try reconnecting Linear.";
    case "token_exchange_failed":
      return "Linear authorized the connection, but token exchange failed. Check the server logs and try again.";
    case "start_failed":
      return "Could not start Linear authorization. Check the server logs and try again.";
    default:
      return "Linear connection failed. Try reconnecting Linear.";
  }
}

function slackMcpSetupErrorMessage(reason: string | null) {
  switch (reason) {
    case "invalid_state":
      return "Slack connection expired or was started in another browser tab. Try reconnecting Slack.";
    case "session_mismatch":
      return "Slack returned to a different OpenCompany session. Sign in to the same workspace and try again.";
    case "slack_denied":
      return "Slack did not authorize the connection.";
    case "missing_code":
      return "Slack did not return an authorization code. Try reconnecting Slack.";
    case "token_exchange_failed":
      return "Slack authorized the connection, but token exchange failed. Check the server logs and try again.";
    case "start_failed":
      return "Could not start Slack authorization. Check SLACK_MCP_CLIENT_ID and SLACK_MCP_CLIENT_SECRET, then try again.";
    default:
      return "Slack connection failed. Try reconnecting Slack.";
  }
}

function posthogMcpSetupErrorMessage(reason: string | null) {
  switch (reason) {
    case "invalid_state":
      return "PostHog connection expired or was started in another browser tab. Try reconnecting PostHog.";
    case "session_mismatch":
      return "PostHog returned to a different OpenCompany session. Sign in to the same workspace and try again.";
    case "posthog_denied":
      return "PostHog did not authorize the connection.";
    case "missing_code":
      return "PostHog did not return an authorization code. Try reconnecting PostHog.";
    case "token_exchange_failed":
      return "PostHog authorized the connection, but token exchange failed. Check the server logs and try again.";
    case "start_failed":
      return "Could not start PostHog authorization. Check the server logs and try again.";
    default:
      return "PostHog connection failed. Try reconnecting PostHog.";
  }
}

function ProfileAvatar({ avatarUrl, initials }: { avatarUrl: string | null; initials: string }) {
  if (avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt=""
        className="h-12 w-12 rounded-full object-cover ring-1 ring-black/[0.06]"
      />
    );
  }
  return (
    <div
      aria-hidden
      className="flex h-12 w-12 items-center justify-center rounded-full text-[14px] font-semibold text-canvas ring-1 ring-black/[0.06]"
      style={{
        background: "radial-gradient(circle at 30% 30%, #c9d9ff 0%, #3b5bdb 35%, #0b1224 80%)",
      }}
    >
      {initials}
    </div>
  );
}

// Resize any picked image to a centered 256px square and encode as webp on the client,
// so we never ship a multi-MB original to the server or store one in Postgres.
async function resizeImageToSquareWebp(
  file: File,
): Promise<{ dataBase64: string; previewUrl: string }> {
  const SIZE = 256;
  const bitmap = await createImageBitmap(file);
  if (!bitmap.width || !bitmap.height) {
    bitmap.close?.();
    throw new Error("Invalid image dimensions.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available.");
  const scale = Math.max(SIZE / bitmap.width, SIZE / bitmap.height);
  const drawW = bitmap.width * scale;
  const drawH = bitmap.height * scale;
  ctx.drawImage(bitmap, (SIZE - drawW) / 2, (SIZE - drawH) / 2, drawW, drawH);
  bitmap.close?.();
  // The server derives the real mime from magic bytes, so we just hand over the bytes.
  // (Browsers without webp encode fall back to png, which the server also accepts.)
  const dataUrl = canvas.toDataURL("image/webp", 0.9);
  const dataBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { dataBase64, previewUrl: dataUrl };
}

function AvatarForm({
  avatarUrl,
  initials,
  hasCustomAvatar,
}: {
  avatarUrl: string | null;
  initials: string;
  hasCustomAvatar: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const hasPhoto = (hasCustomAvatar && !removed) || Boolean(preview);
  const shownUrl = removed ? null : (preview ?? avatarUrl);

  const onPick = async (file: File) => {
    setError(null);
    let resized: { dataBase64: string; previewUrl: string };
    try {
      resized = await resizeImageToSquareWebp(file);
    } catch {
      setError("Could not process that image.");
      return;
    }
    setPreview(resized.previewUrl);
    setRemoved(false);
    startTransition(async () => {
      const res = await updateAvatar({ dataBase64: resized.dataBase64 });
      if (res.ok) {
        router.refresh();
      } else {
        setError(res.error);
        setPreview(null);
      }
    });
  };

  const onRemove = () => {
    setError(null);
    startTransition(async () => {
      const res = await removeAvatar();
      if (res.ok) {
        setPreview(null);
        setRemoved(true);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  };

  return (
    <div className="flex items-center gap-4">
      <ProfileAvatar avatarUrl={shownUrl} initials={initials} />
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onPick(file);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={isPending}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? "Saving…" : hasPhoto ? "Change photo" : "Upload photo"}
          </button>
          {hasPhoto && !isPending && (
            <button
              type="button"
              onClick={onRemove}
              className="inline-flex h-8 items-center rounded-md px-2.5 text-[12.5px] font-medium text-ink-muted transition-colors duration-150 hover:text-ink"
            >
              Remove
            </button>
          )}
        </div>
        {error ? (
          <span className="text-[12px] text-danger">{error}</span>
        ) : (
          <span className="text-[11.5px] text-ink-subtle">
            PNG, JPEG or WebP. Square images look best.
          </span>
        )}
      </div>
    </div>
  );
}

function WorkspaceNameForm({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const dirty = value.trim() !== initial && value.trim().length > 0;

  const submit = (next: string) => {
    setError(null);
    startTransition(async () => {
      const res = await updateWorkspaceName(next);
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 1800);
      } else {
        setError(res.error);
      }
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!dirty || isPending) return;
        submit(value);
      }}
      className="flex items-center gap-2"
    >
      <input
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
        }}
        maxLength={80}
        className="h-8 flex-1 rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none transition-colors focus:border-ink/30 focus:ring-1 focus:ring-ink/15"
      />
      <button
        type="submit"
        disabled={!dirty || isPending}
        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? "Saving…" : "Save"}
      </button>
      {saved && (
        <span className="inline-flex items-center gap-1 text-[12px] text-success">
          <Check size={13} strokeWidth={2} />
          Saved
        </span>
      )}
      {error && <span className="text-[12px] text-danger">{error}</span>}
    </form>
  );
}

export default function SettingsView({
  profile,
  workspace,
  billing,
  mcp,
  toolPolicies,
  experiments,
}: Props) {
  return (
    <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] px-8 pb-24 pt-10">
        <div>
          <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Settings</h1>
          <p className="mt-1 text-[13px] tracking-[-0.005em] text-ink-muted">
            Manage your profile and workspace.
          </p>
        </div>

        <div className="mt-8">
          <Section
            title="Profile"
            description="Shown on your profile. Email is managed by your identity provider."
          >
            {/* key resets the optimistic preview/removed state once the server
                refresh delivers a new avatarUrl (e.g. the IdP avatar after a remove). */}
            <AvatarForm
              key={profile.avatarUrl ?? "none"}
              avatarUrl={profile.avatarUrl}
              initials={profile.initials}
              hasCustomAvatar={profile.hasCustomAvatar}
            />
            <div className="min-w-0">
              <div className="truncate text-[14px] font-medium text-ink">{profile.name}</div>
              <div className="truncate text-[12.5px] text-ink-muted">{profile.email}</div>
            </div>
            <Field label="Email">
              <ReadOnly value={profile.email} />
            </Field>
          </Section>

          <Section title="Appearance" description="Choose the color mode for this device.">
            <Field label="Theme">
              <AppearanceSection />
            </Field>
          </Section>

          <Section title="Workspace" description="Visible to everyone in this workspace.">
            <Field label="Workspace name">
              <WorkspaceNameForm initial={workspace.name} />
            </Field>
            <Field label="Created">
              <ReadOnly value={workspace.createdAt} />
            </Field>
          </Section>

          <Section
            title="Workspace state"
            description="How this workspace is stored and versioned."
          >
            <WorkspaceState sync={workspace.sync} />
          </Section>

          <Section
            title="Integrations"
            description="Connect workspace resources agents can access."
          >
            <Link
              href="/settings/integrations"
              className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted"
            >
              <Plug size={13} strokeWidth={1.9} />
              Open integrations
            </Link>
          </Section>

          <Section title="Billing" description="Workspace credits are stored in USD cents.">
            <BillingSection billing={billing} />
          </Section>

          <Section title="Account" description="Sign out of all sessions for this device.">
            <a
              href="/auth/sign-out"
              className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted"
            >
              <LogOut size={13} strokeWidth={1.9} />
              Log out
            </a>
          </Section>

          <Section title="Experiments" description="Beta capabilities for this workspace.">
            <ExperimentsSection mcp={mcp} toolPolicies={toolPolicies} experiments={experiments} />
          </Section>
        </div>
      </div>
    </main>
  );
}
