"use client";

import { cn } from "@opencompany/ui/lib/utils";
import { ArrowUpRight, Check, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAppDataOptional } from "@/components/AppDataProvider";
import {
  isOfficialMcpPluginName,
  OFFICIAL_MCP_PLUGIN_METADATA,
  type OfficialMcpPluginMetadata,
} from "@/lib/official-plugins";
import { pluginAccountsFromState, pluginConnectionSatisfied } from "@/lib/plugin-connection-state";
import { actionSourceMark } from "@/lib/service-marks";

type PendingConnection = { id: string };

export function PluginConnectionCard({
  pluginName,
  status,
  messageId,
  onResume,
  readOnly = false,
}: {
  pluginName: string;
  status: "not_connected" | "needs_reauth";
  messageId: string;
  onResume?: ((pluginName: string, id: string) => Promise<void>) | undefined;
  readOnly?: boolean;
}) {
  const appData = useAppDataOptional();
  const config: OfficialMcpPluginMetadata | null = isOfficialMcpPluginName(pluginName)
    ? OFFICIAL_MCP_PLUGIN_METADATA[pluginName]
    : null;
  const key = `plugin-connection-resume:${messageId}:${pluginName}`;
  const [pending, setPending] = useState<PendingConnection | null>(null);
  const [resumeError, setResumeError] = useState(false);
  const resuming = useRef(false);
  const attemptedId = useRef<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const connected =
    config && appData?.integrations
      ? pluginConnectionSatisfied(config, pluginAccountsFromState(appData.integrations, config))
      : false;

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(key);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (parsed && typeof parsed === "object" && "id" in parsed && typeof parsed.id === "string")
          setPending({ id: parsed.id });
      }
    } catch {
      // Storage can be unavailable in private browsing; the connection link still works.
    }
  }, [key]);

  useEffect(() => {
    if (
      !connected ||
      !pending ||
      !onResume ||
      readOnly ||
      resuming.current ||
      attemptedId.current === `${pending.id}:${retryCount}`
    )
      return;
    attemptedId.current = `${pending.id}:${retryCount}`;
    resuming.current = true;
    void onResume(pluginName, pending.id)
      .then(() => {
        try {
          window.sessionStorage.removeItem(key);
        } catch {
          // The command already succeeded; storage failure must not offer a duplicate retry.
        }
        setPending(null);
        setResumeError(false);
      })
      .catch(() => setResumeError(true))
      .finally(() => {
        resuming.current = false;
      });
  }, [connected, key, onResume, pending, pluginName, readOnly, retryCount]);

  if (!config || config.connectionUnavailableReason) return null;
  const label = config.accountLabel ?? config.label;
  const mark = actionSourceMark(pluginName);
  const Icon = mark?.Icon;
  const connectLabel = status === "needs_reauth" ? "Reconnect" : "Connect";
  const beginConnection = () => {
    if (readOnly || !onResume) return;
    const next = { id: crypto.randomUUID() };
    try {
      window.sessionStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Keep the pending attempt in component state when storage is unavailable.
    }
    setPending(next);
    setResumeError(false);
  };

  return (
    <div className="flex w-full max-w-[420px] items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-3">
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold",
          mark?.iconClassName ?? "border border-border bg-surface-hover text-ink",
        )}
      >
        {Icon ? <Icon size={17} /> : label.slice(0, 1)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-ink">{label}</div>
        <div className="text-[11px] text-ink-muted">
          {resumeError
            ? "Connected. Could not resume automatically."
            : connected
              ? pending
                ? "Connected · resuming…"
                : "Connected"
              : status === "needs_reauth"
                ? "Reconnect to continue"
                : "Connect to continue"}
        </div>
      </div>
      {connected ? (
        resumeError && pending ? (
          <button
            type="button"
            onClick={() => setRetryCount((count) => count + 1)}
            className="shrink-0 text-xs font-medium text-ink hover:underline"
          >
            Retry
          </button>
        ) : pending ? (
          <LoaderCircle size={15} className="shrink-0 animate-spin text-ink-muted" />
        ) : (
          <Check size={15} className="shrink-0 text-ink-muted" />
        )
      ) : (
        <a
          href={config.connectHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={beginConnection}
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-ink px-2.5 py-1.5 text-[11px] font-medium text-canvas transition-opacity hover:opacity-80"
        >
          {connectLabel}
          <ArrowUpRight size={12} />
        </a>
      )}
    </div>
  );
}
