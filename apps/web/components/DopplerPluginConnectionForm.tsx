"use client";

import { Button } from "@opencompany/ui/components/button";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  cancelDopplerAuth,
  type DopplerAuthFlow,
  type DopplerAuthSettings,
  pollDopplerAuth,
  startDopplerAuth,
} from "@/lib/doppler-auth";

export function DopplerPluginConnectionForm({
  settings,
  enabled,
}: {
  settings: DopplerAuthSettings;
  enabled: boolean;
}) {
  const router = useRouter();
  const [flow, setFlow] = useState<DopplerAuthFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();
  const waiting = flow?.status === "link_ready" || flow?.status === "pending";
  const connected = settings.status === "connected";

  useEffect(() => {
    if (!flow || !waiting || error) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const result = await pollDopplerAuth(flow.id);
      if (!active) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setFlow(result.flow);
      if (result.flow.status === "completed") {
        setFlow(null);
        router.refresh();
        return;
      }
      if (result.flow.status === "failed" || result.flow.status === "expired") {
        setError(result.flow.statusReason ?? "Doppler sign-in failed. Try again.");
        return;
      }
      timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 2500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [flow?.id, waiting, error, router]);

  const connect = () =>
    startTransition(async () => {
      setError(null);
      setCopied(false);
      const result = await startDopplerAuth();
      if (result.ok) setFlow(result.flow);
      else setError(result.error);
    });
  const cancel = (disconnect: boolean) =>
    startTransition(async () => {
      const result = await cancelDopplerAuth(disconnect);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setFlow(null);
      setError(null);
      router.refresh();
    });

  return (
    <section
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4"
      aria-label="Doppler connection"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-semibold text-ink">Sandbox connection</h2>
          <p className="mt-1 text-[13px] leading-5 text-ink-subtle">
            Connect your Doppler account once to use it in your coding sandboxes.
          </p>
        </div>
        <span className="rounded-full bg-surface-muted px-2 py-1 text-[12px] text-ink-subtle">
          {connected
            ? "Connected"
            : settings.status === "needs_reauth"
              ? "Reconnect needed"
              : "Not connected"}
        </span>
      </div>
      {connected && settings.accountName ? (
        <p className="text-[13px] font-medium text-ink">{settings.accountName}</p>
      ) : null}
      <p className="text-[13px] leading-5 text-ink-subtle">
        Agents receive your account’s Doppler permissions, including secret changes where allowed.
        Your repository keeps choosing which projects and configs to use.
      </p>
      {!enabled ? (
        <p className="text-[13px] text-ink-subtle">
          Enable this plugin to use Doppler in your sandboxes.
        </p>
      ) : waiting && flow ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-[13px] text-ink">Enter this code on Doppler’s sign-in page.</p>
          <div className="flex items-center gap-2">
            <code
              className="break-all rounded-md bg-surface-muted px-3 py-2 text-[13px] text-ink"
              aria-label="Authorization code"
            >
              {flow.userCode}
            </code>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Copy authorization code"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(flow.userCode ?? "");
                  setCopied(true);
                } catch {
                  setError("Could not copy the code. Select and copy it manually.");
                }
              }}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
          {flow.loginUrl ? (
            <a
              href={flow.loginUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-[13px] font-medium text-ink underline"
            >
              Open Doppler sign-in <ExternalLink className="size-3.5" />
            </a>
          ) : null}
          <p role="status" className="flex items-center gap-2 text-[12px] text-ink-subtle">
            <Loader2 className="size-3.5 animate-spin" />
            Waiting for authorization. This code expires in a few minutes.
          </p>
          <div className="flex gap-2">
            {error ? (
              <Button size="sm" onClick={() => setError(null)}>
                Check again
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => cancel(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={pending} onClick={connect}>
            {pending ? <Loader2 className="animate-spin" /> : null}
            {connected ? "Reconnect" : "Connect Doppler"}
          </Button>
          {connected || settings.status === "needs_reauth" ? (
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => cancel(true)}>
              Disconnect
            </Button>
          ) : null}
        </div>
      )}
      {error || settings.statusReason ? (
        <p role="alert" className="text-[13px] text-danger">
          {error ?? settings.statusReason}
        </p>
      ) : null}
      {connected ? (
        <p className="text-[12px] leading-5 text-ink-subtle">
          Disconnect removes managed access before the next agent turn. Already running apps may
          retain injected environment variables.
        </p>
      ) : null}
    </section>
  );
}
