"use client";

import { Button } from "@opencompany/ui/components/button";
import { Input } from "@opencompany/ui/components/input";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  disconnectStripeIntegrationAction,
  saveStripeRestrictedApiKeyAction,
} from "@/lib/integrations/stripe-actions";

export function StripeRestrictedKeyConnectionForm({
  connected,
  canManage,
}: {
  connected: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!canManage) {
    return (
      <p className="text-[12px] leading-4 text-ink-subtle">
        Stripe is a workspace connection managed by workspace admins.
      </p>
    );
  }

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await saveStripeRestrictedApiKeyAction(apiKey);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setApiKey("");
      router.refresh();
    });
  };

  const disconnect = () => {
    setError(null);
    startTransition(async () => {
      const result = await disconnectStripeIntegrationAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div
      id="stripe-restricted-key"
      className="flex w-full flex-col gap-3 rounded-lg border border-border p-3"
    >
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-medium text-ink">
          {connected ? "Rotate restricted API key" : "Connect with a restricted API key"}
        </span>
        <p className="text-[12px] leading-5 text-ink-subtle">
          Create a key in{" "}
          <a
            href="https://dashboard.stripe.com/apikeys"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-ink underline underline-offset-2"
          >
            Stripe API keys <ExternalLink className="size-3" />
          </a>
          . Grant read access to Balance, Subscriptions, and Invoices, then add only the other API
          permissions your workspace needs. Unrestricted secret keys are not accepted.
        </p>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-[12px] leading-4 text-ink-subtle">Restricted key</span>
        <Input
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={connected ? "rk_live_… or rk_test_…" : "rk_live_…"}
          disabled={isPending}
          aria-invalid={Boolean(error)}
        />
      </label>
      {error ? <p className="text-[12px] leading-4 text-warning">{error}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[12px] leading-4 text-ink-subtle">
          The key stays encrypted server-side. It is validated with api.stripe.com, and plugin calls
          send it only to mcp.stripe.com.
        </span>
        <div className="flex items-center gap-2">
          {connected ? (
            <Button variant="outline" size="sm" onClick={disconnect} disabled={isPending}>
              Disconnect
            </Button>
          ) : null}
          <Button size="sm" onClick={save} disabled={isPending || apiKey.trim().length === 0}>
            {isPending ? <Loader2 className="animate-spin" /> : <Check />}
            {connected ? "Update key" : "Connect Stripe"}
          </Button>
        </div>
      </div>
    </div>
  );
}
