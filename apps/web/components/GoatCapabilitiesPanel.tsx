"use client";

import type { GoatWorkspaceCapabilityState } from "@opencompany/db/goat-capabilities";
import type { GoatManagedCapabilitySource } from "@opencompany/db/goat-schema";
import { Switch } from "@opencompany/ui/components/switch";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { GoatSettingsContent } from "@/components/GoatSettingsChrome";
import {
  setWorkspaceCapabilityAction,
  setWorkspaceCapabilitySessionBudgetAction,
} from "@/lib/capabilities/actions";

const CAPABILITY_COPY: Record<GoatManagedCapabilitySource, { label: string; description: string }> =
  {
    x: {
      label: "X",
      description: "Search public posts, profiles, threads, and replies.",
    },
    linkedin: {
      label: "LinkedIn",
      description: "Research public people, companies, posts, and comments.",
    },
    youtube: {
      label: "YouTube",
      description: "Search public videos, Shorts, channels, transcripts, and comments.",
    },
    instagram: {
      label: "Instagram",
      description: "Research public profiles, posts, Reels, hashtags, and comments.",
    },
    tiktok: {
      label: "TikTok",
      description: "Search public creators, videos, comments, hashtags, and trends.",
    },
    lead: {
      label: "Prospecting",
      description: "Look up work emails for known prospects or find new targeted professionals.",
    },
    seo: {
      label: "SEO",
      description:
        "Research search visibility, ranking keywords, top pages, competitors, and backlinks with Semrush.",
    },
  };

export function GoatCapabilitiesPanel({
  capabilities,
  sessionBudgetUsdMicros,
  isAdmin,
}: {
  capabilities: GoatWorkspaceCapabilityState[];
  sessionBudgetUsdMicros: number;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(capabilities);
  const [pendingSource, setPendingSource] = useState<GoatManagedCapabilitySource | null>(null);
  const [budgetInput, setBudgetInput] = useState(formatBudgetInput(sessionBudgetUsdMicros));
  const [budgetPending, setBudgetPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const setEnabled = (source: GoatManagedCapabilitySource, enabled: boolean) => {
    setError(null);
    setPendingSource(source);
    startTransition(async () => {
      try {
        const result = await setWorkspaceCapabilityAction({ source, enabled });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setRows((current) =>
          current.map((row) => (row.source === source ? { ...row, enabled } : row)),
        );
        router.refresh();
      } catch {
        setError("Could not update the capability. Try again.");
      } finally {
        setPendingSource(null);
      }
    });
  };

  const saveBudget = () => {
    const normalized = budgetInput.trim();
    const budgetUsd = normalized ? Number(normalized) : null;
    if (
      budgetUsd !== null &&
      (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 1_000)
    ) {
      setError("Enter a spending limit between $0.01 and $1,000.");
      return;
    }
    setError(null);
    setBudgetPending(true);
    startTransition(async () => {
      try {
        const result = await setWorkspaceCapabilitySessionBudgetAction({ budgetUsd });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setBudgetInput(formatBudgetInput(result.budgetUsdMicros));
        router.refresh();
      } catch {
        setError("Could not update the per-chat spending limit. Try again.");
      } finally {
        setBudgetPending(false);
      }
    });
  };

  return (
    <GoatSettingsContent
      title="Capabilities"
      description="Choose which managed research and enrichment sources are available in the main chat."
    >
      <section className="rounded-lg border border-ink/10 px-4 py-4">
        <h2 className="text-[14px] font-medium text-ink">Per-chat spending limit</h2>
        <p className="mt-1 max-w-2xl text-[12px] leading-5 text-ink-subtle">
          Paid lookups run automatically until a chat session&apos;s total cost reaches this limit;
          anything beyond asks for a one-off approval. Default $5.00.
        </p>
        <div className="mt-3 flex max-w-xs items-center gap-2">
          <label htmlFor="capability-session-budget" className="sr-only">
            Per-chat spending limit in US dollars
          </label>
          <div className="relative min-w-0 flex-1">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[13px] text-ink-subtle">
              $
            </span>
            <input
              id="capability-session-budget"
              type="number"
              min="0.01"
              max="1000"
              step="0.01"
              inputMode="decimal"
              value={budgetInput}
              onChange={(event) => setBudgetInput(event.target.value)}
              disabled={!isAdmin || budgetPending}
              className="h-9 w-full rounded-lg border border-ink/15 bg-canvas pl-7 pr-3 text-[13px] text-ink outline-none focus:border-ink/30 disabled:opacity-50"
            />
          </div>
          <button
            type="button"
            onClick={saveBudget}
            disabled={!isAdmin || budgetPending}
            className="h-9 rounded-lg bg-ink px-3 text-[12px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {budgetPending ? "Saving..." : "Save"}
          </button>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-ink/10">
        {rows.map((row, index) => {
          const copy = CAPABILITY_COPY[row.source];
          return (
            <div
              key={row.source}
              className={`flex items-center gap-5 px-4 py-3.5 ${
                index > 0 ? "border-t border-ink/10" : ""
              }`}
            >
              <div className="min-w-0 flex-1">
                <h2 className="text-[14px] font-medium text-ink">{copy.label}</h2>
                <p className="mt-0.5 text-[12px] leading-4 text-ink-subtle">{copy.description}</p>
              </div>
              <Switch
                checked={row.enabled}
                onCheckedChange={(enabled) => setEnabled(row.source, enabled)}
                disabled={!isAdmin || pendingSource !== null}
                aria-label={`${row.enabled ? "Disable" : "Enable"} ${copy.label}`}
              />
            </div>
          );
        })}
      </section>

      <div className="flex flex-col gap-2 text-[12px] leading-5 text-ink-subtle">
        <p>
          Usage is charged to workspace credits at the underlying provider cost. Chat asks for
          one-time approval after the per-chat limit is reached.
        </p>
        <p>
          These are managed capabilities, not connected integrations. Results are saved to Brain
          only when someone explicitly asks.
        </p>
        {!isAdmin ? <p>Only workspace admins can change these settings.</p> : null}
        {error ? (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        ) : null}
      </div>
    </GoatSettingsContent>
  );
}

function formatBudgetInput(valueUsdMicros: number) {
  return (valueUsdMicros / 1_000_000).toFixed(2);
}
