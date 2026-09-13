"use client";

import { Button } from "@opencompany/ui/components/button";
import { Input } from "@opencompany/ui/components/input";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { JamieEventsProviderState } from "@/lib/integration-state";
import { JAMIE_WEBHOOK_API_KEY_HEADER } from "@/lib/integrations/jamie-constants";
import { saveJamieWebhookKeyAction } from "@/lib/integrations/jamie-events-actions";

// Jamie has no webhook-management API, so the connection is made in Jamie's own settings: copy the
// endpoint out of here, create the webhook there, and bring the key Jamie mints back.
export function JamieEventsSetup({ initialState }: { initialState: JamieEventsProviderState }) {
  const router = useRouter();
  const [state, setState] = useState(initialState);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveJamieWebhookKeyAction(apiKey);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setState(result.state);
      setApiKey("");
      router.refresh();
    });
  }

  async function copyWebhookUrl() {
    if (!state.webhookUrl) return;
    await navigator.clipboard.writeText(state.webhookUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div
      id="jamie-webhook"
      className="flex w-full flex-col gap-3 rounded-lg border border-border p-3"
    >
      <div className="flex flex-col gap-1">
        <span className="text-[12px] leading-4 text-ink-subtle">Endpoint URL</span>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-surface-muted px-2.5 py-1.5 text-[12.5px] leading-5 text-ink">
            {state.webhookUrl ?? "Unavailable"}
          </code>
          <Button
            size="sm"
            variant="outline"
            onClick={copyWebhookUrl}
            disabled={!state.webhookUrl}
            aria-label="Copy the Jamie endpoint URL"
          >
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>

      <ol className="list-decimal space-y-1 pl-5 text-[12.5px] leading-5 text-ink-subtle">
        <li>In Jamie, open Settings → Integrations → Webhooks and create a webhook.</li>
        <li>Paste the endpoint URL above and select the meeting.completed event.</li>
        <li>
          Choose a personal webhook for your own meetings, or a workspace webhook for everyone in
          your Jamie workspace.
        </li>
        <li>
          Pick API Key authentication and keep the default {JAMIE_WEBHOOK_API_KEY_HEADER} header
          name.
        </li>
        <li>Copy the sk_ key Jamie shows once and save it below.</li>
      </ol>

      {state.connected ? (
        <div className="flex items-start gap-2 rounded-md bg-surface-muted px-2.5 py-2">
          <Check className="mt-0.5 size-3.5 shrink-0 text-ink" />
          <div>
            <p className="text-[12.5px] font-medium leading-5 text-ink">Webhook key saved</p>
            <p className="text-[12px] leading-4 text-ink-subtle">
              {state.lastDeliveryAt
                ? `Jamie last reached opencompany on ${new Date(state.lastDeliveryAt).toLocaleString()}.`
                : "Nothing has arrived from Jamie yet. Use Jamie's Test button on the webhook to confirm the key."}
            </p>
          </div>
        </div>
      ) : null}

      <label className="flex flex-col gap-1">
        <span className="text-[12px] leading-4 text-ink-subtle">
          {state.connected ? "New webhook key" : "Webhook key"}
        </span>
        <Input
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="sk_..."
          disabled={isPending}
          aria-invalid={Boolean(error)}
        />
      </label>
      {error ? <p className="text-[12px] leading-4 text-warning">{error}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a
          href="https://docs.meetjamie.ai/developers/webhooks/getting-started"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[12px] text-ink-subtle underline decoration-border underline-offset-2 hover:text-ink"
        >
          Jamie webhook setup <ExternalLink className="size-3" />
        </a>
        <Button size="sm" disabled={isPending || !apiKey.trim()} onClick={save}>
          {isPending ? <Loader2 className="animate-spin" /> : <Check />}
          {state.connected ? "Update webhook key" : "Save webhook key"}
        </Button>
      </div>
      <p className="text-[11.5px] leading-4 text-ink-faint">
        Webhooks need a Jamie Plus plan or higher. opencompany stores only a digest of the key, so
        it can recognise Jamie&apos;s deliveries but can never replay or reveal it. Jamie has no way
        to check a key on save; a wrong one shows up as deliveries that never arrive.
      </p>
    </div>
  );
}
