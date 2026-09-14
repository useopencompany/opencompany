"use client";

import type {
  PluginActionPriceDto,
  PluginBillingDto,
  PluginImportPreviewDto,
  PluginInstallationDto,
  PluginPricingDto,
} from "@opencompany/protocol";
import { Button } from "@opencompany/ui/components/button";
import { Input } from "@opencompany/ui/components/input";
import { toast } from "@opencompany/ui/components/sonner";
import { cn } from "@opencompany/ui/lib/utils";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { PageContent } from "@/components/PageContent";
import {
  installOfficialPlugin,
  OFFICIAL_MANAGED_PLUGINS,
  PaidBadge,
  PluginDetail,
} from "@/components/PluginSettings";
import { previewHeadlessPluginImport } from "@/lib/headless-knowledge-commands";
import type { OfficialManagedPluginName } from "@/lib/official-plugins";
import { PLUGIN_DAILY_LIMIT_MAX_USD } from "@/lib/plugins/billing";
import { setPluginDailySpendLimitAction } from "@/lib/plugins/billing-actions";

export type ManagedPluginState =
  | { status: "not_installed" }
  | { status: "installed"; plugin: PluginInstallationDto; billing: PluginBillingDto };

export function ManagedPluginDetail({
  name,
  state,
  canEdit,
}: {
  name: OfficialManagedPluginName;
  state: ManagedPluginState;
  canEdit: boolean;
}) {
  if (state.status === "installed") {
    return (
      <PluginDetail
        plugin={state.plugin}
        canEdit={canEdit}
        title={OFFICIAL_MANAGED_PLUGINS[name].label}
        description={OFFICIAL_MANAGED_PLUGINS[name].description}
        officialPluginName={name}
        billingSection={
          <ManagedPluginBilling
            name={name}
            pricing={state.plugin.pricing}
            billing={state.billing}
            canEdit={canEdit}
          />
        }
      />
    );
  }
  return <ManagedPluginInstall name={name} canEdit={canEdit} />;
}

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; preview: PluginImportPreviewDto }
  | { status: "error"; message: string };

function ManagedPluginInstall({
  name,
  canEdit,
}: {
  name: OfficialManagedPluginName;
  canEdit: boolean;
}) {
  const config = OFFICIAL_MANAGED_PLUGINS[name];
  const router = useRouter();
  const [previewState, setPreviewState] = useState<PreviewState>({ status: "loading" });
  const [installError, setInstallError] = useState<string | null>(null);
  const [isInstalling, startInstall] = useTransition();

  useEffect(() => {
    let active = true;
    void previewHeadlessPluginImport({ url: config.source })
      .then((preview) => {
        if (active) setPreviewState({ status: "ready", preview });
      })
      .catch((cause) => {
        if (active) {
          setPreviewState({
            status: "error",
            message: cause instanceof Error ? cause.message : "The package could not be read.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [config.source]);

  const install = () => {
    if (isInstalling || previewState.status !== "ready") return;
    setInstallError(null);
    startInstall(async () => {
      try {
        await installOfficialPlugin(config, previewState.preview);
        toast.success(`${config.label} installed.`);
        router.refresh();
      } catch (cause) {
        setInstallError(
          cause instanceof Error ? cause.message : "The plugin could not be installed.",
        );
      }
    });
  };

  return (
    <PageContent
      title={config.label}
      description={config.description}
      backLink={{ href: "/plugins", label: "Plugins" }}
    >
      <section className="flex flex-wrap items-start gap-3 rounded-lg border border-border bg-surface p-4">
        <span
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-lg",
            config.iconClassName,
          )}
        >
          <config.Icon className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold text-ink">{config.label}</h2>
            <PaidBadge />
            <span className="inline-flex rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-subtle">
              Not installed
            </span>
          </div>
          <p className="mt-1 text-[12.5px] leading-5 text-ink-subtle">{config.billingSummary}</p>
        </div>
        {canEdit ? (
          <Button
            size="sm"
            disabled={isInstalling || previewState.status !== "ready"}
            onClick={install}
          >
            {isInstalling || previewState.status === "loading" ? (
              <Loader2 className="animate-spin" />
            ) : null}
            {isInstalling
              ? "Installing…"
              : previewState.status === "loading"
                ? "Loading package…"
                : previewState.status === "error"
                  ? "Install unavailable"
                  : "Install"}
          </Button>
        ) : null}
      </section>

      {!canEdit ? (
        <p className="text-[13px] leading-5 text-ink-subtle">
          You need plugin write permission to install plugins.
        </p>
      ) : null}

      {previewState.status === "loading" ? (
        <div
          aria-label={`Loading ${config.label} prices`}
          className="rounded-lg border border-border bg-surface px-3 py-3 text-[12.5px] text-ink-subtle"
        >
          Loading prices…
        </div>
      ) : previewState.status === "error" ? (
        <p className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-[12.5px] text-danger">
          {previewState.message}
        </p>
      ) : (
        <PriceTable pricing={previewState.preview.pricing} />
      )}

      {installError ? <p className="text-[12.5px] text-danger">{installError}</p> : null}
    </PageContent>
  );
}

export function ManagedPluginBilling({
  name,
  pricing,
  billing,
  canEdit,
}: {
  name: OfficialManagedPluginName;
  pricing: PluginPricingDto | null;
  billing: PluginBillingDto;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [limitInput, setLimitInput] = useState(formatLimitInput(billing.dailyLimitUsdMicros));
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSave] = useTransition();

  const save = () => {
    const normalized = limitInput.trim();
    const dailyLimitUsd = normalized ? Number(normalized) : null;
    if (
      dailyLimitUsd !== null &&
      (!Number.isFinite(dailyLimitUsd) ||
        dailyLimitUsd <= 0 ||
        dailyLimitUsd > PLUGIN_DAILY_LIMIT_MAX_USD)
    ) {
      setError(
        `Enter a daily limit between $0.01 and $${PLUGIN_DAILY_LIMIT_MAX_USD.toLocaleString("en-US")}, or leave it empty for no limit.`,
      );
      return;
    }
    setError(null);
    startSave(async () => {
      const result = await setPluginDailySpendLimitAction({ pluginName: name, dailyLimitUsd });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLimitInput(formatLimitInput(result.billing.dailyLimitUsdMicros));
      toast.success(
        result.billing.dailyLimitUsdMicros === null
          ? "Daily spending limit removed."
          : "Daily spending limit saved.",
      );
      router.refresh();
    });
  };

  return (
    <>
      <PriceTable pricing={pricing} />
      <section className="flex flex-col gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
          Daily spending limit
        </h2>
        <div className="rounded-lg border border-border bg-surface px-3 py-3">
          <p className="text-[12.5px] leading-5 text-ink-subtle">
            Caps what this plugin can spend across the whole workspace each day (UTC). Lookups that
            would pass the cap are refused until the next day. Leave empty for no limit.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-ink-subtle">
                $
              </span>
              <Input
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                max={PLUGIN_DAILY_LIMIT_MAX_USD}
                value={limitInput}
                disabled={!canEdit || isSaving}
                onChange={(event) => setLimitInput(event.target.value)}
                placeholder="No limit"
                aria-label="Daily spending limit in US dollars"
                className="h-9 w-40 pl-6 text-[13px]"
              />
            </div>
            <Button size="sm" variant="outline" disabled={!canEdit || isSaving} onClick={save}>
              {isSaving ? <Loader2 className="animate-spin" /> : null}
              {isSaving ? "Saving…" : "Save"}
            </Button>
            <span className="text-[12px] text-ink-subtle">
              {formatUsd(billing.spentTodayUsdMicros)} spent today
            </span>
          </div>
          {error ? <p className="mt-2 text-[12.5px] text-danger">{error}</p> : null}
          {!canEdit ? (
            <p className="mt-2 text-[12px] text-ink-subtle">
              Only workspace admins can change this limit.
            </p>
          ) : null}
        </div>
      </section>
    </>
  );
}

function PriceTable({ pricing }: { pricing: PluginPricingDto | null }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[12px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
        Prices
      </h2>
      {!pricing || pricing.actions.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface px-3 py-2.5 text-[12.5px] text-ink-subtle">
          This package declares no prices, so its actions are unavailable.
        </p>
      ) : (
        <>
          <ul className="overflow-hidden rounded-lg border border-border bg-surface">
            {pricing.actions.map((price: PluginActionPriceDto) => (
              <li
                key={price.action}
                className="flex items-baseline justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-ink">
                    {actionLabel(price.action)}
                  </p>
                  <p className="text-[12px] leading-4 text-ink-subtle">
                    {price.unit === "per_result"
                      ? `Per ${price.label.toLocaleLowerCase()}`
                      : "Per lookup that finds a match"}
                  </p>
                </div>
                <span className="shrink-0 whitespace-nowrap text-[13px] font-medium tabular-nums text-ink">
                  {formatUsd(price.amountUsdMicros)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[12px] leading-4 text-ink-subtle">
            Charged to workspace credits only when a lookup returns results. Lookups that find
            nothing, and lookups that fail, are free.
          </p>
        </>
      )}
    </section>
  );
}

function actionLabel(action: string) {
  const words = action.replaceAll("_", " ");
  return words.charAt(0).toLocaleUpperCase() + words.slice(1);
}

function formatUsd(usdMicros: number) {
  const usd = usdMicros / 1_000_000;
  return usd < 1
    ? `${(usd * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}¢`
    : `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatLimitInput(usdMicros: number | null) {
  return usdMicros === null ? "" : String(usdMicros / 1_000_000);
}
