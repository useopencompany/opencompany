"use client";

import { OpenAIIcon } from "@opencompany/ui/icons";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setCodexWorkspaceEngineEnabled } from "@/lib/codex-auth";
import type { CodexProviderState } from "@/lib/integration-state";

export function InferenceSettingsPanel({
  integration,
  canManage,
}: {
  integration: CodexProviderState;
  canManage: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const account = integration.workspaceEngine;
  const enabled = account?.enabled === true;
  const canEnable = integration.connected;

  const update = () => {
    setError(null);
    startTransition(async () => {
      const result = await setCodexWorkspaceEngineEnabled(!enabled);
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  };

  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-black text-white">
          <OpenAIIcon size={24} />
        </div>
        <div className="flex flex-col gap-1">
          <h2 className="text-[15px] font-semibold leading-tight text-ink">
            Subscription-backed models
          </h2>
          <p className="text-[13px] leading-5 text-ink-subtle">
            Route GPT 5.6 Sol and Terra through a workspace admin&apos;s ChatGPT subscription.
          </p>
        </div>
        <div className="flex flex-col gap-1 text-[12px] leading-4 text-ink-subtle">
          {account ? (
            <p>
              {enabled ? "Enabled" : "Disabled"} · {account.providerDisplayName} (
              {account.providerEmail})
            </p>
          ) : (
            <p>Uses metered workspace credits until an admin enables this connection.</p>
          )}
          {account?.credentialStatus === "needs_reauth" ? (
            <p className="text-warning">
              {account.credentialStatusReason ?? "The provider must reconnect Codex."}
            </p>
          ) : null}
          {!enabled && canManage && !canEnable ? (
            <p>Connect your personal Codex account first, then enable workspace routing.</p>
          ) : null}
          {!canManage ? <p>Managed by workspace admins.</p> : null}
          {error ? <p className="text-warning">{error}</p> : null}
        </div>
        {canManage ? (
          <div className="mt-auto pt-1">
            <button
              type="button"
              onClick={update}
              disabled={isPending || (!enabled && !canEnable)}
              aria-busy={isPending}
              className="inline-flex items-center justify-center rounded-full border border-border px-4 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover disabled:opacity-60"
            >
              {isPending ? "Updating" : enabled ? "Disable" : "Enable with my account"}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
