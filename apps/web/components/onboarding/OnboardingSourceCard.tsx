"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { BookOpen, Check, ExternalLink, LoaderCircle, Settings2 } from "lucide-react";
import { useTransition } from "react";
import { brainSourceHasScope, resolveBrainSourceState } from "@/components/BrainSourceCards";
import { type BrainSourcesDetails, setBrainSourceEnabledAction } from "@/lib/brain-source-actions";
import { type BrainSourceProviderDef, brainSourceNeedsConfig } from "@/lib/brain-sources/registry";

// Compact onboarding row for a single source. Unlike the full settings card
// (multi-account, per-member rows, pause toggles), onboarding only needs to move
// the owner from "not connected" → "feeding" as directly as possible. The three
// visible states are deliberate:
//   • not connected → a Connect / Set up call-to-action
//   • connected but not yet feeding → an amber "Finish setup" that reads as
//     unfinished, with the config surface one click away
//   • feeding → a green confirmation, with an optional Adjust for scoped sources
export function OnboardingSourceCard({
  brainRef,
  provider,
  details,
  onConnect,
  onConfigure,
  onChanged,
  connectPending,
  connectDisabled,
}: {
  brainRef: string;
  provider: BrainSourceProviderDef;
  details: BrainSourcesDetails | null;
  onConnect: () => void;
  onConfigure: () => void;
  onChanged: () => Promise<void>;
  connectPending: boolean;
  connectDisabled: boolean;
}) {
  const Icon = provider.icon;
  const [isEnabling, startEnabling] = useTransition();
  const state = resolveBrainSourceState(provider.id, details);
  const { connected, integrationId } = state;
  const needsConfig = brainSourceNeedsConfig(provider.id);
  const feeding = state.enabled && brainSourceHasScope(provider.id, state.source?.config);
  const needsSetup = connected && !feeding;

  // No-scope providers (Jamie / Granola / Fathom) are enabled directly on
  // connect, but expose a manual fallback here if that ever misses.
  const turnOn = () => {
    if (!integrationId) return;
    startEnabling(async () => {
      const result = await setBrainSourceEnabledAction({
        brainRef,
        provider: provider.id,
        integrationId,
        enabled: true,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await onChanged();
    });
  };

  return (
    <div
      className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
        feeding
          ? "border-success-border bg-success-bg/40"
          : needsSetup
            ? "border-warning-border bg-warning-bg/50"
            : "border-border bg-surface"
      }`}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink">
        <Icon size={16} strokeWidth={1.8} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-ink">{provider.name}</span>
          {feeding ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-success">
              <Check size={10} strokeWidth={3} />
              Feeding
            </span>
          ) : needsSetup ? (
            <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-warning">
              Finish setup
            </span>
          ) : null}
        </div>
        <p className="truncate text-[11.5px] leading-4 text-ink-subtle">
          {needsSetup && needsConfig
            ? "Authorized — choose what should flow into your Brain."
            : provider.description}
        </p>
        {!connected && provider.docsHref ? (
          <a
            href={provider.docsHref}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex w-fit items-center gap-1 text-[11px] font-medium text-ink-subtle transition-colors hover:text-ink"
          >
            <BookOpen size={11} strokeWidth={1.9} />
            Setup guide
            <ExternalLink size={10} strokeWidth={1.9} />
          </a>
        ) : null}
      </div>

      <div className="shrink-0">
        {!connected ? (
          <button
            type="button"
            onClick={onConnect}
            disabled={connectDisabled || connectPending}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink/15 px-3 text-[12px] font-medium text-ink transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {connectPending ? (
              <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />
            ) : null}
            {connectPending
              ? "Connecting"
              : provider.connectionKind === "oauth"
                ? "Connect"
                : "Set up"}
          </button>
        ) : needsSetup ? (
          needsConfig ? (
            <button
              type="button"
              onClick={onConfigure}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12px] font-semibold text-canvas transition-opacity hover:opacity-90"
            >
              <Settings2 size={13} strokeWidth={2} />
              Configure
            </button>
          ) : (
            <button
              type="button"
              onClick={turnOn}
              disabled={isEnabling}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12px] font-semibold text-canvas transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {isEnabling ? (
                <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />
              ) : null}
              Turn on
            </button>
          )
        ) : needsConfig ? (
          <button
            type="button"
            onClick={onConfigure}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink/15 px-3 text-[12px] font-medium text-ink transition-colors hover:bg-surface-hover"
          >
            <Settings2 size={13} strokeWidth={1.9} />
            Adjust
          </button>
        ) : null}
      </div>
    </div>
  );
}
