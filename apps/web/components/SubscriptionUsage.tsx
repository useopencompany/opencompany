"use client";

import type { SubscriptionUsage as SubscriptionUsageSnapshot } from "@opencompany/protocol";
import { Button } from "@opencompany/ui/components/button";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { loadCurrentClaudeCodeUsage } from "@/lib/claude-code-auth";
import { loadCurrentCodexUsage } from "@/lib/codex-auth";

type UsageProvider = "codex" | "claude_code";

const PROVIDERS = {
  codex: {
    name: "Codex",
    load: loadCurrentCodexUsage,
    barClassName: "bg-[#2b8d98]",
  },
  claude_code: {
    name: "Claude",
    load: loadCurrentClaudeCodeUsage,
    barClassName: "bg-[#CC785C]",
  },
} as const satisfies Record<
  UsageProvider,
  {
    name: string;
    load: () => Promise<
      { ok: true; usage: SubscriptionUsageSnapshot } | { ok: false; error: string }
    >;
    barClassName: string;
  }
>;

export function SubscriptionUsage({ provider }: { provider: UsageProvider }) {
  const { name, load, barClassName } = PROVIDERS[provider];
  const [usage, setUsage] = useState<SubscriptionUsageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    let active = true;
    void load()
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          setUsage(result.usage);
          setError(null);
        } else {
          setError(result.error);
        }
        setNow(Date.now());
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setError(`${name} usage is temporarily unavailable. Try again shortly.`);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refresh, load, name]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
      setLoading(true);
      setRefresh((value) => value + 1);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      className="flex flex-col gap-4 border-t border-border pt-4"
      aria-label={`${name} subscription usage`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] text-ink-subtle" aria-live="polite">
          {loading && !usage
            ? "Checking usage…"
            : usage
              ? `Updated ${elapsedLabel(now - Date.parse(usage.updatedAt))}`
              : "Usage unavailable"}
        </p>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 rounded-full text-ink-subtle"
          aria-label={`Refresh ${name} usage`}
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setRefresh((value) => value + 1);
          }}
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
        </Button>
      </div>
      {usage?.windows.map((window) => {
        const remaining = Math.floor(100 - window.usedPercent);
        const resetIn = Date.parse(window.resetsAt) - now;
        const expired = resetIn <= 0;
        return (
          <div key={window.id} className={`flex flex-col gap-2 ${expired ? "opacity-60" : ""}`}>
            <p className="text-[13px] font-medium text-ink">{window.label}</p>
            <div
              role="progressbar"
              aria-label={`${window.label} remaining`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={remaining}
              aria-valuetext={expired ? "Awaiting updated usage" : `${remaining}% left`}
              className="h-1.5 overflow-hidden rounded-full bg-surface-hover"
            >
              <div
                className={`h-full rounded-full transition-[width] ${remaining <= 10 ? "bg-warning" : barClassName}`}
                style={{ width: `${remaining}%` }}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[12px] leading-4">
              <span className="tabular-nums text-ink-muted">
                {expired ? "Awaiting update" : `${remaining}% left`}
              </span>
              <span className="text-ink-subtle" title={new Date(window.resetsAt).toLocaleString()}>
                {expired ? "Reset time passed" : `Resets in ${durationLabel(resetIn)}`}
              </span>
            </div>
          </div>
        );
      })}
      {usage && usage.windows.length === 0 ? (
        <p className="text-[12px] leading-5 text-ink-subtle">
          {name} hasn’t reported usage limits for this account.
        </p>
      ) : null}
      {error ? (
        <p role="status" className="text-[12px] leading-5 text-warning">
          {error}
          {usage ? " Showing the last update." : ""}
        </p>
      ) : null}
      <p className="text-[11px] leading-4 text-ink-subtle">
        Your subscription usage across all apps.
      </p>
    </div>
  );
}

function elapsedLabel(milliseconds: number) {
  if (milliseconds < 60_000) return "just now";
  return `${durationLabel(milliseconds)} ago`;
}

function durationLabel(milliseconds: number) {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}
