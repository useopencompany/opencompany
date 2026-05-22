"use client";

import { Check, CreditCard, Gift, GitBranch, LogOut, WalletCards } from "lucide-react";
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
import { updateWorkspaceName } from "@/lib/workspaces/actions";

type Props = {
  profile: {
    name: string;
    email: string;
    avatarUrl: string | null;
    initials: string;
  };
  workspace: {
    name: string;
    createdAt: string;
    repository: {
      updatedAt: string;
    } | null;
  };
  billing: {
    balanceCents: number;
    ledger: Array<{
      id: number;
      amountCents: number;
      source: string;
      createdAt: string;
      metadata: Record<string, unknown>;
    }>;
  };
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
    <section className="border-t border-[#eaeae6] py-7 first:border-t-0 first:pt-0">
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
    <div className="rounded-md border border-[#e6e6e3] bg-white/60 px-2.5 py-1.5 text-[13px] text-ink/85">
      {value}
    </div>
  );
}

function formatUsd(cents: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function ledgerLabel(source: string) {
  if (source === "stripe_checkout") return "Credit top-up";
  if (source === "credit_code") return "Redeemed code";
  if (source === "usage") return "Usage";
  return "Credit event";
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
          ? "bg-[#111] text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] hover:bg-black"
          : "border border-[#e1e1dd] bg-white text-ink hover:bg-[#f5f5f1]"
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
      className="flex h-8 min-w-[184px] items-center rounded-md border border-[#e1e1dd] bg-white transition-colors focus-within:border-ink/30 focus-within:ring-1 focus-within:ring-ink/15"
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
        className="inline-flex h-full shrink-0 items-center gap-1.5 rounded-r-md border-l border-[#e1e1dd] px-2.5 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-[#f5f5f1] disabled:cursor-not-allowed disabled:opacity-40"
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
      <div className="rounded-lg border border-[#e3e3df] bg-white/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#e6e6e3] bg-[#f7f7f5] text-ink-muted">
              <WalletCards size={15} strokeWidth={1.8} />
            </span>
            <div>
              <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">
                Current balance
              </div>
              <div className="mt-1 text-[28px] font-semibold leading-none tracking-[-0.015em] text-ink">
                {formatUsd(billing.balanceCents)}
              </div>
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
        {checkoutError && <div className="mt-2 text-[12px] text-[#b42318]">{checkoutError}</div>}
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
        className="rounded-lg border border-[#e3e3df] bg-white/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#e6e6e3] bg-[#f7f7f5] text-ink-muted">
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
                className="h-8 min-w-0 flex-1 rounded-md border border-[#e6e6e3] bg-white px-2.5 text-[13px] uppercase text-ink outline-none transition-colors placeholder:normal-case placeholder:text-ink-subtle focus:border-ink/30 focus:ring-1 focus:ring-ink/15"
              />
              <button
                type="submit"
                disabled={isPending || !code.trim()}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-[#111] px-3 text-[12.5px] font-medium text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-black disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isPending ? "Redeeming..." : "Redeem"}
              </button>
            </div>
            {message && (
              <div
                className={`mt-2 text-[12px] ${
                  message.type === "success" ? "text-[#1f7a3a]" : "text-[#b42318]"
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
          Recent activity
        </div>
        {billing.ledger.length === 0 ? (
          <div className="rounded-md border border-dashed border-[#deded9] bg-white/35 px-3 py-3 text-[12px] leading-5 text-ink-muted">
            Billing activity will appear here.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-[#e3e3df] bg-white/55">
            {billing.ledger.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-4 border-t border-[#ecece8] px-3 py-2.5 first:border-t-0"
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
                    entry.amountCents >= 0 ? "text-[#1f7a3a]" : "text-ink"
                  }`}
                >
                  {entry.amountCents >= 0 ? "+" : ""}
                  {formatUsd(entry.amountCents)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function WorkspaceState({ repository }: { repository: Props["workspace"]["repository"] }) {
  return (
    <div className="rounded-lg border border-[#e3e3df] bg-white/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#e6e6e3] bg-[#f7f7f5] text-ink-muted">
          <GitBranch size={15} strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">
            Managed by opencompany through Git
          </div>
          <p className="mt-1 text-[12px] leading-5 text-ink-muted">
            Your workspace files are versioned automatically in a private Git-backed repository.
          </p>
          <div className="mt-3 text-[11.5px] text-ink-subtle">
            {repository ? `Last updated ${repository.updatedAt}` : "Git storage is being set up"}
          </div>
        </div>
      </div>
    </div>
  );
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
      className="flex h-12 w-12 items-center justify-center rounded-full text-[14px] font-semibold text-white ring-1 ring-black/[0.06]"
      style={{
        background: "radial-gradient(circle at 30% 30%, #c9d9ff 0%, #3b5bdb 35%, #0b1224 80%)",
      }}
    >
      {initials}
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
        className="h-8 flex-1 rounded-md border border-[#e6e6e3] bg-white px-2.5 text-[13px] text-ink outline-none transition-colors focus:border-ink/30 focus:ring-1 focus:ring-ink/15"
      />
      <button
        type="submit"
        disabled={!dirty || isPending}
        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#111] px-3 text-[12.5px] font-medium text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-black disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? "Saving…" : "Save"}
      </button>
      {saved && (
        <span className="inline-flex items-center gap-1 text-[12px] text-[#1f7a3a]">
          <Check size={13} strokeWidth={2} />
          Saved
        </span>
      )}
      {error && <span className="text-[12px] text-[#b42318]">{error}</span>}
    </form>
  );
}

export default function SettingsView({ profile, workspace, billing }: Props) {
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
          <Section title="Profile" description="Managed by your identity provider (WorkOS).">
            <div className="flex items-center gap-3">
              <ProfileAvatar avatarUrl={profile.avatarUrl} initials={profile.initials} />
              <div className="min-w-0">
                <div className="truncate text-[14px] font-medium text-ink">{profile.name}</div>
                <div className="truncate text-[12.5px] text-ink-muted">{profile.email}</div>
              </div>
            </div>
            <Field label="Email">
              <ReadOnly value={profile.email} />
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
            <WorkspaceState repository={workspace.repository} />
          </Section>

          <Section title="Billing" description="Workspace credits are stored in USD cents.">
            <BillingSection billing={billing} />
          </Section>

          <Section title="Account" description="Sign out of all sessions for this device.">
            <Link
              href="/auth/sign-out"
              className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-[#e6e6e3] bg-white px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-[#f5f5f1]"
            >
              <LogOut size={13} strokeWidth={1.9} />
              Log out
            </Link>
          </Section>
        </div>
      </div>
    </main>
  );
}
