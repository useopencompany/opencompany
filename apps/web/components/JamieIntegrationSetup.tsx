"use client";

import { Check, Copy, RotateCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import type { GoatJamieProviderState } from "@/lib/integration-state";
import {
  createOrResetJamieWebhookEndpointAction,
  saveJamieWebhookApiKeyAction,
} from "@/lib/integrations/jamie-actions";
import { GOAT_JAMIE_WEBHOOK_SECRET_HEADER } from "@/lib/integrations/jamie-constants";

type EndpointSetup = {
  integrationId: string;
  webhookUrl: string;
  headerName: string;
  apiKeyConfigured: boolean;
};

export function JamieIntegrationSetup({
  initialState,
  brainSourcesHref = null,
  canManage = true,
  variant = "settings",
  onSaved,
}: {
  initialState: GoatJamieProviderState;
  brainSourcesHref?: string | null;
  // Jamie is a workspace-owned integration; members see status only while
  // admins get the webhook + API key setup.
  canManage?: boolean;
  // "modal" embeds the form in the onboarding connect dialog: the Status
  // section (which duplicates the dialog title) is dropped.
  variant?: "settings" | "modal";
  // Fired only after a successful API-key save — creating the endpoint alone
  // does not make Jamie connected.
  onSaved?: () => void;
}) {
  const router = useRouter();
  const [endpoint, setEndpoint] = useState<EndpointSetup | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const webhookUrl = endpoint?.webhookUrl ?? initialState.webhookUrl;
  const headerName = endpoint?.headerName ?? GOAT_JAMIE_WEBHOOK_SECRET_HEADER;
  const apiKeyConfigured =
    endpoint?.apiKeyConfigured ?? initialState.apiKeyConfigured ?? initialState.connected;
  const status = useMemo(
    () => setupStatus(initialState, Boolean(webhookUrl), apiKeyConfigured),
    [apiKeyConfigured, initialState, webhookUrl],
  );

  function createEndpoint() {
    setError(null);
    startTransition(async () => {
      const result = await createOrResetJamieWebhookEndpointAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEndpoint(result.setup);
      setApiKey("");
      router.refresh();
    });
  }

  function saveApiKey() {
    setError(null);
    startTransition(async () => {
      const result = await saveJamieWebhookApiKeyAction(apiKey);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEndpoint(result.setup);
      setApiKey("");
      router.refresh();
      onSaved?.();
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
      {variant === "modal" ? (
        canManage ? null : (
          <p className="px-2 text-[12px] leading-4 text-ink-subtle">
            Jamie is a workspace integration managed by workspace admins.
          </p>
        )
      ) : (
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
          {apiKeyConfigured && brainSourcesHref ? (
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
          {canManage ? null : (
            <p className="px-2 text-[12px] leading-4 text-ink-subtle">
              Jamie is a workspace integration managed by workspace admins.
            </p>
          )}
        </section>
      )}

      {canManage ? (
        <ManageJamieSections
          webhookUrl={webhookUrl}
          headerName={headerName}
          apiKeyConfigured={apiKeyConfigured}
          apiKey={apiKey}
          error={error}
          copiedKey={copiedKey}
          isPending={isPending}
          onApiKeyChange={setApiKey}
          onCreateEndpoint={createEndpoint}
          onSaveApiKey={saveApiKey}
          onCopy={copyValue}
        />
      ) : null}
    </div>
  );
}

function ManageJamieSections({
  webhookUrl,
  headerName,
  apiKeyConfigured,
  apiKey,
  error,
  copiedKey,
  isPending,
  onApiKeyChange,
  onCreateEndpoint,
  onSaveApiKey,
  onCopy,
}: {
  webhookUrl: string | null;
  headerName: string;
  apiKeyConfigured: boolean;
  apiKey: string;
  error: string | null;
  copiedKey: string | null;
  isPending: boolean;
  onApiKeyChange: (value: string) => void;
  onCreateEndpoint: () => void;
  onSaveApiKey: () => void;
  onCopy: (key: string, value: string | null) => Promise<void>;
}) {
  return (
    <>
      <section className="flex flex-col gap-3">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Jamie webhook
        </h2>
        <SetupValue
          label="Endpoint URL"
          value={webhookUrl ?? "Create an endpoint first"}
          copyable={Boolean(webhookUrl)}
          copied={copiedKey === "url"}
          onCopy={() => onCopy("url", webhookUrl)}
        />
        <SetupValue
          label="Header name"
          value={headerName}
          copyable
          copied={copiedKey === "header"}
          onCopy={() => onCopy("header", headerName)}
        />
        {error ? <p className="px-2 text-[12px] leading-4 text-red-600">{error}</p> : null}
        <div className="pt-1">
          <button
            type="button"
            onClick={onCreateEndpoint}
            disabled={isPending}
            className="inline-flex items-center gap-2 rounded-md bg-ink px-3 py-2 text-[13px] font-medium leading-none text-canvas transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCw size={14} strokeWidth={2} />
            {webhookUrl ? "Reset setup" : "Create endpoint"}
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Jamie API key
        </h2>
        {apiKeyConfigured ? (
          <div className="mx-2 flex items-start gap-2 rounded-md border border-border bg-surface-muted px-2.5 py-2">
            <Check size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-ink" />
            <div className="min-w-0">
              <span className="block text-[13px] font-medium leading-5 text-ink">
                API key saved
              </span>
              <span className="block text-[12px] leading-4 text-ink-subtle">
                Paste a new Jamie API key below to update it.
              </span>
            </div>
          </div>
        ) : null}
        <label className="flex flex-col gap-1 px-2">
          <span className="text-[12px] leading-4 text-ink-subtle">
            {apiKeyConfigured ? "New API key" : "API key"}
          </span>
          <input
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={apiKeyConfigured ? "Paste a new sk_ key" : "sk_..."}
            disabled={!webhookUrl || isPending}
            className="h-9 rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-border-strong disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
        <div className="flex flex-col items-start gap-3 px-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="min-w-0 text-[12px] leading-4 text-ink-subtle">
            {apiKeyConfigured
              ? "Leave blank to keep the saved key."
              : "Save the key Jamie shows after creation."}
          </span>
          <button
            type="button"
            onClick={onSaveApiKey}
            disabled={!webhookUrl || isPending || apiKey.trim().length === 0}
            className="inline-flex shrink-0 items-center gap-2 rounded-md bg-ink px-3 py-2 text-[13px] font-medium leading-none text-canvas transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Check size={14} strokeWidth={2} />
            {apiKeyConfigured ? "Update API key" : "Save API key"}
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Setup in Jamie
        </h2>
        <ol className="list-decimal space-y-2 pl-6 text-[13px] leading-5 text-ink-subtle">
          <li>Create a Jamie webhook for completed meetings and paste the endpoint URL.</li>
          <li>Set the event to meeting.completed.</li>
          <li>Select API Key authentication and leave the header name as x-jamie-api-key.</li>
          <li>Copy the sk_ API key Jamie shows once, paste it here, and save it.</li>
        </ol>
      </section>
    </>
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

function setupStatus(
  initialState: GoatJamieProviderState,
  hasEndpoint: boolean,
  apiKeyConfigured: boolean,
) {
  if (initialState.connected) {
    return {
      label: "Jamie is connected",
      detail: "New completed meeting notes are accepted by the Goat Brain ingestion queue.",
      badge: "Connected",
    };
  }
  if (hasEndpoint && apiKeyConfigured) {
    return {
      label: "Ready for Brain",
      detail: "Enable Jamie from a brain's Sources settings to route completed meetings.",
      badge: "Ready",
    };
  }
  if (hasEndpoint) {
    return {
      label: "Waiting for API key",
      detail: "Create the webhook in Jamie, then save the API key Jamie shows.",
      badge: "Setup",
    };
  }
  return {
    label: "Not connected",
    detail: "Create an endpoint, then add it in Jamie.",
    badge: "Setup",
  };
}
