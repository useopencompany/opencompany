"use client";

import { cn } from "@opencompany/ui/lib/utils";
import { ArrowUpRight, Check, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAppDataOptional } from "@/components/AppDataProvider";
import {
  isOfficialMcpPluginName,
  OFFICIAL_MCP_PLUGIN_METADATA,
  type OfficialMcpPluginMetadata,
} from "@/lib/official-plugins";
import { pluginAccountsFromState, pluginConnectionSatisfied } from "@/lib/plugin-connection-state";
import { actionSourceMark } from "@/lib/service-marks";

const PENDING_CONNECTION_CHANGED = "opencompany-plugin-connection-pending";

function subscribeToPendingConnection(listener: () => void) {
  window.addEventListener(PENDING_CONNECTION_CHANGED, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(PENDING_CONNECTION_CHANGED, listener);
    window.removeEventListener("storage", listener);
  };
}

function pendingConnectionId(key: string): string | null {
  try {
    const stored = window.sessionStorage.getItem(key);
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    return parsed && typeof parsed === "object" && "id" in parsed && typeof parsed.id === "string"
      ? parsed.id
      : null;
  } catch {
    return null;
  }
}

function noPendingConnection() {
  return null;
}

function notifyPendingConnectionChanged() {
  window.dispatchEvent(new Event(PENDING_CONNECTION_CHANGED));
}

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
  const router = useRouter();
  const appData = useAppDataOptional();
  const config: OfficialMcpPluginMetadata | null = isOfficialMcpPluginName(pluginName)
    ? OFFICIAL_MCP_PLUGIN_METADATA[pluginName]
    : null;
  const key = `plugin-connection-resume:${messageId}:${pluginName}`;
  const storedPendingId = useSyncExternalStore(
    subscribeToPendingConnection,
    useCallback(() => pendingConnectionId(key), [key]),
    noPendingConnection,
  );
  const [fallbackPendingId, setFallbackPendingId] = useState<string | null>(null);
  const pendingId = fallbackPendingId ?? storedPendingId;
  const [resumeError, setResumeError] = useState(false);
  const resuming = useRef(false);
  const attemptedId = useRef<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const connected =
    config && appData?.integrations
      ? pluginConnectionSatisfied(config, pluginAccountsFromState(appData.integrations, config))
      : false;

  // Most personal connections arrive through the live integration projection. A few managed or
  // server-selected connections only change in AppShell's server snapshot, so refresh that snapshot
  // when the user returns from the connection tab.
  useEffect(() => {
    if (!pendingId || connected || readOnly) return;
    const refreshConnectionState = () => router.refresh();
    window.addEventListener("focus", refreshConnectionState);
    return () => window.removeEventListener("focus", refreshConnectionState);
  }, [connected, pendingId, readOnly, router]);

  useEffect(() => {
    if (
      !connected ||
      !pendingId ||
      !onResume ||
      readOnly ||
      resuming.current ||
      attemptedId.current === `${pendingId}:${retryCount}`
    )
      return;
    attemptedId.current = `${pendingId}:${retryCount}`;
    resuming.current = true;
    void onResume(pluginName, pendingId)
      .then(() => {
        try {
          window.sessionStorage.removeItem(key);
          notifyPendingConnectionChanged();
        } catch {
          // The command already succeeded; storage failure must not offer a duplicate retry.
        }
        setFallbackPendingId(null);
        setResumeError(false);
      })
      .catch(() => setResumeError(true))
      .finally(() => {
        resuming.current = false;
      });
  }, [connected, key, onResume, pendingId, pluginName, readOnly, retryCount]);

  if (!config || config.connectionUnavailableReason) return null;
  const label = config.accountLabel ?? config.label;
  const mark = actionSourceMark(pluginName);
  const Icon = mark?.Icon;
  const connectLabel = status === "needs_reauth" ? "Reconnect" : "Connect";
  const beginConnection = () => {
    if (readOnly || !onResume) return;
    const id = crypto.randomUUID();
    try {
      window.sessionStorage.setItem(key, JSON.stringify({ id }));
      notifyPendingConnectionChanged();
    } catch {
      // Keep the pending attempt in component state when storage is unavailable.
    }
    setFallbackPendingId(id);
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
              ? pendingId
                ? "Connected · resuming…"
                : "Connected"
              : status === "needs_reauth"
                ? "Reconnect to continue"
                : "Connect to continue"}
        </div>
      </div>
      {connected ? (
        resumeError && pendingId ? (
          <button
            type="button"
            onClick={() => setRetryCount((count) => count + 1)}
            className="shrink-0 text-xs font-medium text-ink hover:underline"
          >
            Retry
          </button>
        ) : pendingId ? (
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
