"use client";

import { Button } from "@opencompany/ui/components/button";
import { Check, ExternalLink, Loader2, Unplug, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ConvexEventsProviderState } from "@/lib/integration-state";
import {
  disableConvexErrorEventsAction,
  enableConvexErrorEventsAction,
} from "@/lib/integrations/convex-events-actions";

const DISCONNECTED: ConvexEventsProviderState = {
  provider: "convex",
  connected: false,
  status: "not_connected",
  integrationId: null,
  statusReason: null,
  deployment: null,
  webhookUrl: null,
  lastDeliveryAt: null,
};

// Convex's deployment API can create a webhook log stream with the deploy key already saved above,
// so turning error events on is one button: opencompany creates the stream, Convex hands back the
// signing secret, and nothing is copied by hand in either direction.
export function ConvexErrorEventsSetup({
  initialState,
  deployKeyConnected,
}: {
  initialState: ConvexEventsProviderState;
  deployKeyConnected: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState(initialState);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function enable() {
    setError(null);
    startTransition(async () => {
      const result = await enableConvexErrorEventsAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setState(result.state);
      router.refresh();
    });
  }

  function disable() {
    setError(null);
    startTransition(async () => {
      const result = await disableConvexErrorEventsAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setState(DISCONNECTED);
      router.refresh();
    });
  }

  return (
    <div
      id="convex-error-events"
      className="flex w-full flex-col gap-3 rounded-lg border border-border p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-[12.5px] font-medium leading-5 text-ink">Error events</p>
          <p className="text-[12px] leading-4 text-ink-subtle">
            Start a workflow when a function in this deployment fails.
          </p>
        </div>
        {state.connected ? (
          <Button size="sm" variant="outline" disabled={isPending} onClick={disable}>
            {isPending ? <Loader2 className="animate-spin" /> : <Unplug />}
            Turn off
          </Button>
        ) : (
          <Button size="sm" disabled={isPending || !deployKeyConnected} onClick={enable}>
            {isPending ? <Loader2 className="animate-spin" /> : <Zap />}
            Turn on
          </Button>
        )}
      </div>

      {state.connected ? (
        <div className="flex items-start gap-2 rounded-md bg-surface-muted px-2.5 py-2">
          <Check className="mt-0.5 size-3.5 shrink-0 text-ink" />
          <div>
            <p className="text-[12.5px] font-medium leading-5 text-ink">
              Log stream running{state.deployment ? ` on ${state.deployment}` : ""}
            </p>
            <p className="text-[12px] leading-4 text-ink-subtle">
              {state.lastDeliveryAt
                ? `Convex last reached opencompany on ${new Date(state.lastDeliveryAt).toLocaleString()}.`
                : "Waiting for Convex's first delivery. It sends a verification event right after the stream is created."}
            </p>
          </div>
        </div>
      ) : deployKeyConnected ? null : (
        <p className="text-[12px] leading-4 text-ink-subtle">
          Save a deploy key above first — opencompany uses it to create the log stream in Convex.
        </p>
      )}

      {error ? <p className="text-[12px] leading-4 text-warning">{error}</p> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <a
          href="https://docs.convex.dev/production/integrations/log-streams/"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[12px] text-ink-subtle underline decoration-border underline-offset-2 hover:text-ink"
        >
          Convex log streams <ExternalLink className="size-3" />
        </a>
      </div>

      <p className="text-[11.5px] leading-4 text-ink-faint">
        Log streams need a Convex Pro plan, and the deploy key needs deployment:integrations:write.
        opencompany subscribes the stream to function executions only, verifies every
        delivery&apos;s signature, and groups repeat failures of the same function so one incident
        starts one workflow run. Turning this off deletes the stream in Convex.
      </p>
    </div>
  );
}
