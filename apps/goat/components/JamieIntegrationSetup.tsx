"use client";

import { Check, Copy, RotateCw } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import type { GoatJamieProviderState } from "@/lib/integration-state";
import { createOrRotateJamieWebhookSecretAction } from "@/lib/integrations/jamie-actions";
import { GOAT_JAMIE_WEBHOOK_SECRET_HEADER } from "@/lib/integrations/jamie-constants";

type GeneratedSetup = {
  integrationId: string;
  webhookUrl: string;
  headerName: string;
  secret: string;
};

export function JamieIntegrationSetup({ initialState }: { initialState: GoatJamieProviderState }) {
  const [generated, setGenerated] = useState<GeneratedSetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const webhookUrl = generated?.webhookUrl ?? initialState.webhookUrl;
  const headerName = generated?.headerName ?? GOAT_JAMIE_WEBHOOK_SECRET_HEADER;
  const status = useMemo(() => setupStatus(initialState, generated), [generated, initialState]);

  function generateSecret() {
    setError(null);
    startTransition(async () => {
      const result = await createOrRotateJamieWebhookSecretAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setGenerated(result.setup);
    });
  }

  async function copyValue(key: string, value: string | null) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1200);
  }

  return (
    <div className="flex flex-col gap-8">
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
            {initialState.connected ? "Connected" : "Setup"}
          </span>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Jamie webhook
        </h2>
        <SetupValue
          label="Endpoint URL"
          value={webhookUrl ?? "Generate a secret first"}
          copyable={Boolean(webhookUrl)}
          copied={copiedKey === "url"}
          onCopy={() => copyValue("url", webhookUrl)}
        />
        <SetupValue
          label="Header name"
          value={headerName}
          copyable
          copied={copiedKey === "header"}
          onCopy={() => copyValue("header", headerName)}
        />
        <SetupValue
          label="Secret"
          value={generated?.secret ?? "Hidden after generation"}
          copyable={Boolean(generated?.secret)}
          copied={copiedKey === "secret"}
          onCopy={() => copyValue("secret", generated?.secret ?? null)}
        />
        {error ? <p className="px-2 text-[12px] leading-4 text-red-600">{error}</p> : null}
        <div className="pt-1">
          <button
            type="button"
            onClick={generateSecret}
            disabled={isPending}
            className="inline-flex items-center gap-2 rounded-md bg-ink px-3 py-2 text-[13px] font-medium leading-none text-canvas transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCw size={14} strokeWidth={2} />
            {initialState.integrationId ? "Rotate secret" : "Generate secret"}
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Setup in Jamie
        </h2>
        <ol className="list-decimal space-y-2 pl-6 text-[13px] leading-5 text-ink-subtle">
          <li>Create a Jamie webhook for completed meetings.</li>
          <li>Set the event to meeting.completed.</li>
          <li>Use the endpoint URL and send the secret in the x-jamie-api-key header.</li>
        </ol>
      </section>
    </div>
  );
}

function SetupValue({
  label,
  value,
  copyable,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copyable: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2">
      <div className="min-w-0 flex-1">
        <span className="block text-[12px] leading-4 text-ink-subtle">{label}</span>
        <code className="block truncate text-[13px] font-medium leading-5 text-ink">{value}</code>
      </div>
      <button
        type="button"
        onClick={onCopy}
        disabled={!copyable}
        title={`Copy ${label}`}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        {copied ? <Check size={15} strokeWidth={2} /> : <Copy size={15} strokeWidth={2} />}
      </button>
    </div>
  );
}

function setupStatus(initialState: GoatJamieProviderState, generated: GeneratedSetup | null) {
  if (initialState.connected) {
    return {
      label: "Jamie is connected",
      detail: "New completed meeting notes are accepted by the Goat Brain ingestion queue.",
    };
  }
  if (generated || initialState.status === "needs_reauth") {
    return {
      label: "Waiting for Jamie",
      detail:
        initialState.statusReason ?? "Send the first completed-meeting webhook to finish setup.",
    };
  }
  return {
    label: "Not connected",
    detail: "Generate a webhook secret, then add the endpoint in Jamie.",
  };
}
