"use client";

import { Check, ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { disconnectIntegrationAccountAction } from "@/lib/integration-account-actions";
import type { IntegrationAccountView, PostHogEventsProviderState } from "@/lib/integration-state";
import { savePostHogEventsConnectionAction } from "@/lib/integrations/posthog-events-actions";

export function PostHogEventsSetup({
  initialAccount,
}: {
  initialAccount: IntegrationAccountView | null;
}) {
  const router = useRouter();
  const savedProject = /^Project ([1-9][0-9]*) · (US|EU)$/.exec(
    initialAccount?.connectionLabel ?? "",
  );
  const [state, setState] = useState<PostHogEventsProviderState>(() => ({
    provider: "posthog",
    connected: initialAccount?.connected ?? false,
    status: initialAccount?.status ?? "not_connected",
    integrationId: initialAccount?.integrationId ?? null,
    projectId: null,
    region: null,
    connectionLabel: initialAccount?.connectionLabel ?? null,
    statusReason: initialAccount?.statusReason ?? null,
  }));
  const [apiKey, setApiKey] = useState("");
  const [projectId, setProjectId] = useState(savedProject?.[1] ?? "");
  const [region, setRegion] = useState<"us" | "eu">(savedProject?.[2] === "EU" ? "eu" : "us");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function connect() {
    setError(null);
    startTransition(async () => {
      const result = await savePostHogEventsConnectionAction({ apiKey, projectId, region });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setState(result.state);
      setApiKey("");
      setProjectId(result.state.projectId ?? projectId);
      setRegion(result.state.region ?? region);
      router.refresh();
    });
  }

  function disconnect() {
    if (!state.integrationId) return;
    setError(null);
    startTransition(async () => {
      const result = await disconnectIntegrationAccountAction(state.integrationId as string);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setState({
        provider: "posthog",
        connected: false,
        status: "not_connected",
        integrationId: null,
        projectId: null,
        region: null,
        connectionLabel: null,
        statusReason: null,
      });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border p-3">
      <div className="flex flex-col gap-1">
        <p className="text-[13px] font-medium text-ink">PostHog event connection</p>
        <p className="text-[12px] leading-4 text-ink-subtle">
          Use a separate read-only personal API key so workflows can discover and poll analytics
          events even when the PostHog tools are disconnected.
        </p>
      </div>
      {state.connected ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-surface-muted px-2.5 py-2">
          <Check className="mt-0.5 size-3.5 shrink-0 text-ink" />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-ink">PostHog events connected</p>
            <p className="text-[12px] text-ink-subtle">
              {state.connectionLabel ?? "The project is ready for event workflows."}
            </p>
          </div>
        </div>
      ) : null}
      {state.status === "needs_reauth" || state.status === "sync_failed" ? (
        <p role="alert" className="text-[12px] leading-4 text-warning">
          {state.statusReason ?? "PostHog needs a new personal API key."}
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-subtle">Project ID</span>
          <input
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            inputMode="numeric"
            placeholder={state.connected ? "Enter to change project" : "12345"}
            disabled={isPending}
            className="h-9 rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong disabled:opacity-60"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-subtle">Data region</span>
          <select
            value={region}
            onChange={(event) => setRegion(event.target.value as "us" | "eu")}
            disabled={isPending}
            className="h-9 rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-border-strong disabled:opacity-60"
          >
            <option value="us">United States</option>
            <option value="eu">Europe</option>
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-ink-subtle">
          {state.connected ? "New personal API key" : "Personal API key"}
        </span>
        <input
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="phx_..."
          disabled={isPending}
          className="h-9 rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong disabled:opacity-60"
        />
      </label>
      {error ? (
        <p role="alert" className="text-[12px] leading-4 text-warning">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <a
          href="https://posthog.com/docs/api/auth#personal-api-keys"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[12px] text-ink-subtle hover:text-ink"
        >
          Create a key with query:read and event_definition:read
          <ExternalLink className="size-3" />
        </a>
        <div className="flex shrink-0 gap-2">
          {state.connected ? (
            <button
              type="button"
              onClick={disconnect}
              disabled={isPending}
              className="rounded-md border border-ink/15 px-3 py-2 text-[13px] font-medium leading-none text-ink hover:bg-surface-hover disabled:opacity-50"
            >
              Disconnect
            </button>
          ) : null}
          <button
            type="button"
            onClick={connect}
            disabled={isPending || !apiKey.trim() || !projectId.trim()}
            className="inline-flex items-center gap-2 rounded-md bg-ink px-3 py-2 text-[13px] font-medium leading-none text-canvas hover:opacity-90 disabled:opacity-50"
          >
            <Check className="size-3.5" />
            {state.connected ? "Update connection" : "Connect events"}
          </button>
        </div>
      </div>
      <p className="text-[12px] leading-4 text-ink-subtle">
        New matching events normally start a workflow within two minutes. Each PostHog event starts
        a given workflow once, including after retries or restarts.
      </p>
    </div>
  );
}
