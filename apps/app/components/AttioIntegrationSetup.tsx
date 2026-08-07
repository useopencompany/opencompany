"use client";

import { Check } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { AttioProviderState } from "@/lib/integration-state";
import {
  disconnectAttioIntegrationAction,
  saveAttioApiKeyAction,
} from "@/lib/integrations/attio-actions";

export function AttioIntegrationSetup({
  initialState,
  brainSourcesHref = null,
  variant = "settings",
  onSaved,
}: {
  initialState: AttioProviderState;
  brainSourcesHref?: string | null;
  // "modal" embeds the form in the onboarding connect dialog: the Status
  // section (which duplicates the dialog title) is dropped.
  variant?: "settings" | "modal";
  onSaved?: () => void;
}) {
  const router = useRouter();
  const [state, setState] = useState(initialState);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const status = setupStatus(state);

  function saveApiKey() {
    setError(null);
    startTransition(async () => {
      const result = await saveAttioApiKeyAction(apiKey);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setState(result.state);
      setApiKey("");
      router.refresh();
      onSaved?.();
    });
  }

  function disconnect() {
    if (!state.integrationId) return;
    setError(null);
    startTransition(async () => {
      const result = await disconnectAttioIntegrationAction(state.integrationId as string);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setState({
        provider: "attio",
        connected: false,
        status: "not_connected",
        integrationId: null,
        workspaceName: null,
        statusReason: null,
      });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-8">
      {variant === "modal" ? null : (
        <section className="flex flex-col gap-1">
          <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
            Status
          </h2>
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[14px] font-medium leading-tight text-ink">{status.label}</span>
              {status.detail ? (
                <span className="text-[12px] leading-4 text-ink-subtle">{status.detail}</span>
              ) : null}
            </div>
            <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle">
              {status.badge}
            </span>
          </div>
          {state.connected && brainSourcesHref ? (
            <div className="px-2 pt-1">
              <Link
                href={brainSourcesHref}
                prefetch
                className="inline-flex items-center rounded-md border border-ink/15 px-2.5 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-surface-hover"
              >
                Open Brain sources
              </Link>
            </div>
          ) : null}
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Attio API key
        </h2>
        {state.connected ? (
          <div className="mx-2 flex items-start gap-2 rounded-md border border-border bg-surface-muted px-2.5 py-2">
            <Check size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-ink" />
            <div className="min-w-0">
              <span className="block text-[13px] font-medium leading-5 text-ink">
                API key saved
              </span>
              <span className="block text-[12px] leading-4 text-ink-subtle">
                Paste a new Attio API key below to replace it.
              </span>
            </div>
          </div>
        ) : null}
        <label className="flex flex-col gap-1 px-2">
          <span className="text-[12px] leading-4 text-ink-subtle">
            {state.connected ? "New API key" : "API key"}
          </span>
          <input
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={state.connected ? "Paste a new Attio API key" : "Attio API key"}
            disabled={isPending}
            className="h-9 rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-border-strong disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
        {error ? <p className="px-2 text-[12px] leading-4 text-warning">{error}</p> : null}
        <div className="flex flex-col items-start gap-3 px-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="min-w-0 text-[12px] leading-4 text-ink-subtle">
            {state.connected
              ? "Leave blank to keep the saved key."
              : "Create the key in Attio, then paste it here."}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {state.connected ? (
              <button
                type="button"
                onClick={disconnect}
                disabled={isPending}
                className="inline-flex items-center rounded-md border border-ink/15 px-3 py-2 text-[13px] font-medium leading-none text-ink transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                Disconnect
              </button>
            ) : null}
            <button
              type="button"
              onClick={saveApiKey}
              disabled={isPending || apiKey.trim().length === 0}
              className="inline-flex items-center gap-2 rounded-md bg-ink px-3 py-2 text-[13px] font-medium leading-none text-canvas transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check size={14} strokeWidth={2} />
              {state.connected ? "Update API key" : "Save API key"}
            </button>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Setup in Attio
        </h2>
        <ol className="list-decimal space-y-2 pl-6 text-[13px] leading-5 text-ink-subtle">
          <li>In Attio, open Workspace settings and go to Developers.</li>
          <li>
            Create an integration and generate an access token with these scopes:{" "}
            <code>object_configuration:read</code>, <code>record_permission:read-write</code>,{" "}
            <code>list_configuration:read-write</code>, <code>list_entry:read-write</code>,{" "}
            <code>note:read-write</code>, and <code>webhook:read-write</code>.
          </li>
          <li>Copy the token, paste it here, and save it.</li>
          <li>Enable Attio from a brain&apos;s Sources settings to route CRM activity.</li>
        </ol>
        <p className="px-2 text-[13px] leading-5 text-ink-subtle">
          Saving the key registers an Attio webhook so new and updated people, companies, deals, and
          notes flow into the brain as they happen. The same connection also lets Chat search those
          standard records, read Attio lists, and configure list pipeline fields.
        </p>
      </section>
    </div>
  );
}

function setupStatus(state: AttioProviderState) {
  if (state.connected) {
    return {
      label: state.workspaceName ? `Connected to ${state.workspaceName}` : "Attio is connected",
      detail: "CRM activity is picked up by the Goat Brain ingestion queue.",
      badge: "Connected",
    };
  }
  if (state.status === "needs_reauth" || state.status === "sync_failed") {
    return {
      label: "Needs a new API key",
      detail: state.statusReason ?? "Attio rejected the saved key. Paste a new one below.",
      badge: "Reconnect",
    };
  }
  return {
    label: "Not connected",
    detail: "Paste an Attio API key to ingest CRM activity from your workspace.",
    badge: "Setup",
  };
}
