"use client";

import { Button } from "@opencompany/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { Input } from "@opencompany/ui/components/input";
import { cn } from "@opencompany/ui/lib/utils";
import { ExternalLink, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  completeInfisicalAuth,
  disconnectInfisicalAuth,
  type InfisicalAuthFlow,
  startInfisicalAuth,
} from "@/lib/infisical-auth";
import type { InfisicalProviderState } from "@/lib/integration-state";

type InfisicalHost = NonNullable<InfisicalProviderState["host"]>;

const INFISICAL_REGIONS = [
  { host: "https://app.infisical.com", label: "US" },
  { host: "https://eu.infisical.com", label: "EU" },
] as const satisfies ReadonlyArray<{ host: InfisicalHost; label: string }>;

export function InfisicalPluginConnectionForm({
  integration,
  canManage,
}: {
  integration: InfisicalProviderState;
  canManage: boolean;
}) {
  const router = useRouter();
  const [flow, setFlow] = useState<InfisicalAuthFlow | null>(null);
  const [host, setHost] = useState<InfisicalHost>(
    integration.host === "https://eu.infisical.com"
      ? "https://eu.infisical.com"
      : "https://app.infisical.com",
  );
  const [browserToken, setBrowserToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [isPending, startTransition] = useTransition();

  const startAuth = () => {
    setError(null);
    setBrowserToken("");
    startTransition(async () => {
      const result = await startInfisicalAuth({ host });
      if (result.ok) setFlow(result.flow);
      else setError(result.error);
    });
  };

  const completeAuth = () => {
    if (!flow) return;
    setError(null);
    startTransition(async () => {
      const result = await completeInfisicalAuth({ flowId: flow.id, browserToken });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.flow.status === "completed") {
        setFlow(null);
        setBrowserToken("");
        router.refresh();
      } else {
        setFlow(result.flow);
        setError(result.flow.statusReason);
      }
    });
  };

  const disconnect = () => {
    setError(null);
    startTransition(async () => {
      const result = await disconnectInfisicalAuth();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfirmingDisconnect(false);
      setFlow(null);
      setBrowserToken("");
      router.refresh();
    });
  };

  const regionLabel = INFISICAL_REGIONS.find((region) => region.host === host)?.label ?? "US";

  if (!canManage) {
    return (
      <p className="text-[12px] leading-4 text-ink-subtle">
        This workspace connection is managed by workspace admins.
      </p>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {flow?.status === "link_ready" && flow.loginUrl ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <p className="text-[12px] leading-5 text-ink-muted">
            Open Infisical {regionLabel}, finish signing in without changing regions, then copy the
            browser token immediately.
          </p>
          <a
            href={flow.loginUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-1.5 text-[12px] font-medium text-ink underline underline-offset-2"
          >
            Open Infisical sign-in
            <ExternalLink className="size-3" />
          </a>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] leading-4 text-ink-subtle">Browser token</span>
            <Input
              type="password"
              value={browserToken}
              onChange={(event) => setBrowserToken(event.target.value)}
              placeholder="Paste browser token"
              autoComplete="off"
              spellCheck={false}
              disabled={isPending}
              aria-invalid={Boolean(error)}
            />
          </label>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={completeAuth} disabled={isPending || !browserToken.trim()}>
              {isPending ? <Loader2 className="animate-spin" /> : null}
              Finish connection
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFlow(null);
                setBrowserToken("");
                setError(null);
              }}
              disabled={isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[12px] leading-4 text-ink-subtle">Region</span>
            <div
              role="group"
              aria-label="Infisical region"
              className="inline-flex rounded-full bg-surface-muted p-0.5"
            >
              {INFISICAL_REGIONS.map((region) => {
                const selected = region.host === host;
                return (
                  <button
                    key={region.host}
                    type="button"
                    aria-pressed={selected}
                    disabled={isPending}
                    onClick={() => setHost(region.host)}
                    className={cn(
                      "rounded-full px-2.5 py-0.5 text-[11px] font-medium leading-4 transition-colors duration-150",
                      selected ? "bg-surface text-ink shadow-sm" : "text-ink-subtle hover:text-ink",
                    )}
                  >
                    {region.label}
                  </button>
                );
              })}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={startAuth} disabled={isPending}>
            {isPending ? <Loader2 className="animate-spin" /> : null}
            {connectionButtonLabel(integration.status)} Infisical account
          </Button>
          {integration.connected ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmingDisconnect(true)}
              disabled={isPending}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      )}
      {flow?.statusReason || error ? (
        <p className="text-[12px] leading-4 text-warning">{error ?? flow?.statusReason}</p>
      ) : null}
      <p className="text-[11.5px] leading-4 text-ink-faint">
        Coding agents inherit this account&apos;s permissions, including secret writes. Use a
        dedicated, least-privilege account.
      </p>

      <Dialog open={confirmingDisconnect} onOpenChange={setConfirmingDisconnect}>
        <DialogContent className="max-w-[440px] gap-5">
          <DialogHeader className="text-left">
            <DialogTitle className="text-[15px]">Disconnect Infisical?</DialogTitle>
            <DialogDescription className="text-[12.5px] leading-5 text-ink-subtle">
              New coding turns will no longer restore the saved login. Commands already running are
              not interrupted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmingDisconnect(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={disconnect} disabled={isPending}>
              {isPending ? <Loader2 className="animate-spin" /> : null}
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function connectionButtonLabel(status: InfisicalProviderState["status"]) {
  if (status === "connected" || status === "needs_reauth") return "Reconnect";
  return "Connect";
}
