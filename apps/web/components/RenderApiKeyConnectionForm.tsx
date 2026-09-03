"use client";

import { Button } from "@opencompany/ui/components/button";
import { Input } from "@opencompany/ui/components/input";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveRenderApiKeyAction } from "@/lib/integrations/render-actions";

export function RenderApiKeyConnectionForm({ connected }: { connected: boolean }) {
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveRenderApiKeyAction(apiKey);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setApiKey("");
      router.refresh();
    });
  }

  return (
    <div
      id="render-api-key"
      className="flex w-full flex-col gap-3 rounded-lg border border-border p-3"
    >
      {connected ? (
        <div className="flex items-start gap-2 rounded-md bg-surface-muted px-2.5 py-2">
          <Check className="mt-0.5 size-3.5 shrink-0 text-ink" />
          <div>
            <p className="text-[12.5px] font-medium leading-5 text-ink">API key saved</p>
            <p className="text-[12px] leading-4 text-ink-subtle">
              Paste a new key below only when you want to replace it.
            </p>
          </div>
        </div>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className="text-[12px] leading-4 text-ink-subtle">
          {connected ? "New Render API key" : "Render API key"}
        </span>
        <Input
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="rnd_..."
          disabled={isPending}
          aria-invalid={Boolean(error)}
        />
      </label>
      {error ? <p className="text-[12px] leading-4 text-warning">{error}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a
          href="https://dashboard.render.com/u/settings/api-keys"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[12px] text-ink-subtle underline decoration-border underline-offset-2 hover:text-ink"
        >
          Create a Render API key <ExternalLink className="size-3" />
        </a>
        <Button size="sm" disabled={isPending || !apiKey.trim()} onClick={save}>
          {isPending ? <Loader2 className="animate-spin" /> : <Check />}
          {connected ? "Update API key" : "Save API key"}
        </Button>
      </div>
      <p className="text-[11.5px] leading-4 text-ink-faint">
        Render API keys have account-level access. opencompany encrypts the key, keeps it
        server-side, and sends it only to Render&apos;s official MCP endpoint.
      </p>
    </div>
  );
}
