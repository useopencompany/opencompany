"use client";

import { Button } from "@opencompany/ui/components/button";
import { toast } from "@opencompany/ui/components/sonner";
import { cn } from "@opencompany/ui/lib/utils";
import { Check, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  installOfficialPlugin,
  OFFICIAL_MCP_PLUGINS,
  type OfficialMcpPluginConfig,
} from "@/lib/official-plugin-catalog";
import { getOnboardingInstalledPluginsAction } from "@/lib/onboarding-actions";
import {
  integrationConnectionError,
  ONBOARDING_CONNECTION_MESSAGE,
  ONBOARDING_CONNECTION_STORAGE_KEY,
  type OnboardingConnectionResult,
  onboardingConnectHref,
} from "@/lib/onboarding-integrations";

// GitHub leads: it is the one plugin that makes the coding sandboxes from the
// previous step immediately useful. The rest are the catalog's featured set.
const RECOMMENDED: OfficialMcpPluginConfig = OFFICIAL_MCP_PLUGINS.github;
const ALSO_POPULAR: OfficialMcpPluginConfig[] = [
  OFFICIAL_MCP_PLUGINS.linear,
  OFFICIAL_MCP_PLUGINS.gmail,
  OFFICIAL_MCP_PLUGINS.slack,
  OFFICIAL_MCP_PLUGINS.notion,
];

const CONNECT_POPUP_FEATURES = "width=600,height=760,noopener=no,noreferrer=no";

export function OnboardingPluginsStep({
  onInstalledCountChange,
}: {
  onInstalledCountChange: (count: number) => void;
}) {
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [connecting, setConnecting] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    void getOnboardingInstalledPluginsAction().then((names) => {
      if (active) setInstalled(new Set(names));
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    onInstalledCountChange(installed.size);
  }, [installed, onInstalledCountChange]);

  const markConnected = (result: OnboardingConnectionResult) => {
    if (!result.provider) return;
    if (result.status === "connected") {
      setConnected((current) => new Set(current).add(result.provider as string));
      return;
    }
    if (result.status === "error") {
      toast.error(integrationConnectionError(result.provider, result.reason));
    }
  };

  useConnectionResults(markConnected);

  const connect = (config: OfficialMcpPluginConfig, isInstalled: boolean) => {
    if (isPending) return;

    const href = onboardingConnectHref(config.connectHref);
    const popup = window.open(href, "_blank", CONNECT_POPUP_FEATURES);
    if (popup) popup.focus();

    if (isInstalled) {
      // Popup blocked: the connected route writes the result to localStorage and
      // bounces back to /onboarding, which resumes on this step via the cookie.
      if (!popup) window.location.assign(href);
      return;
    }

    setConnecting(config.name);
    startTransition(async () => {
      try {
        await installOfficialPlugin(config);
        setInstalled((current) => new Set(current).add(config.name));
        // Keep installation and authorization as one user action. When the popup
        // was blocked, wait for installation to finish before leaving this page.
        if (!popup) window.location.assign(href);
      } catch (cause) {
        popup?.close();
        toast.error(
          `Couldn't connect ${config.label}. ${cause instanceof Error ? cause.message : "Please try again."}`,
        );
      } finally {
        setConnecting(null);
      }
    });
  };

  return (
    <div>
      <div className="mb-7 flex flex-col gap-2">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">
          Give your agent some tools
        </h1>
        <p className="text-[14px] leading-6 text-ink-muted">
          Plugins let opencompany act in the tools you already use. Connect a few now, or add them
          later from Plugins in the sidebar.
        </p>
      </div>

      <div className="flex flex-col gap-2.5">
        <PluginRow
          config={RECOMMENDED}
          recommended
          installed={installed.has(RECOMMENDED.name)}
          connected={connected.has(RECOMMENDED.connectionProvider)}
          connecting={connecting === RECOMMENDED.name}
          disabled={isPending}
          onConnect={connect}
        />

        <p className="mt-3 text-[12px] font-medium text-ink-subtle">Also popular</p>
        {ALSO_POPULAR.map((config) => (
          <PluginRow
            key={config.name}
            config={config}
            installed={installed.has(config.name)}
            connected={connected.has(config.connectionProvider)}
            connecting={connecting === config.name}
            disabled={isPending}
            onConnect={connect}
          />
        ))}
      </div>
    </div>
  );
}

function PluginRow({
  config,
  recommended = false,
  installed,
  connected,
  connecting,
  disabled,
  onConnect,
}: {
  config: OfficialMcpPluginConfig;
  recommended?: boolean;
  installed: boolean;
  connected: boolean;
  connecting: boolean;
  disabled: boolean;
  onConnect: (config: OfficialMcpPluginConfig, installed: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border bg-surface px-3.5 py-3",
        recommended ? "border-ink/30 bg-surface-active/30" : "border-border",
      )}
    >
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70",
          config.iconClassName,
        )}
      >
        <config.Icon className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-ink">{config.label}</span>
          {recommended && (
            <span className="shrink-0 rounded-full border border-ink/25 px-2 py-0.5 text-[11px] font-medium leading-4 text-ink">
              Recommended
            </span>
          )}
          {connected && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium leading-4 text-success">
              <Check size={11} strokeWidth={3} />
              Connected
            </span>
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-ink-subtle">
          {config.description}
        </p>
      </div>
      <div className="shrink-0">
        {installed && connected ? null : (
          <Button
            variant={recommended && !installed ? "default" : "outline"}
            size="sm"
            disabled={disabled}
            aria-busy={connecting}
            onClick={() => onConnect(config, installed)}
            className="h-8 gap-1.5 rounded-full px-3 text-[12px] shadow-none"
          >
            {connecting ? <Loader2 className="animate-spin" /> : null}
            {connecting ? "Connecting…" : "Connect"}
          </Button>
        )}
      </div>
    </div>
  );
}

// Connection results arrive either as a postMessage from the popup or, when the
// popup was blocked and the flow ran in this tab, as a localStorage record left
// behind by /onboarding/connected before it bounced back here.
function useConnectionResults(onResult: (result: OnboardingConnectionResult) => void) {
  const handlerRef = useRef(onResult);
  useEffect(() => {
    handlerRef.current = onResult;
  }, [onResult]);

  useEffect(() => {
    let initialResult: OnboardingConnectionResult | null = null;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(ONBOARDING_CONNECTION_STORAGE_KEY);
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts. The
      // postMessage path below remains the primary connection-result channel.
    }
    if (stored) {
      try {
        window.localStorage.removeItem(ONBOARDING_CONNECTION_STORAGE_KEY);
      } catch {
        // The parsed result is still usable even if clearing storage is denied.
      }
      try {
        initialResult = JSON.parse(stored) as OnboardingConnectionResult;
      } catch {
        // A malformed record is not worth surfacing; it has been cleared.
      }
    }

    // When storage is blocked, the popup fallback returns the same result in
    // the onboarding URL. Consume it once, then remove only those callback
    // parameters so refreshes do not replay a stale result.
    const params = new URLSearchParams(window.location.search);
    if (params.has("setup")) {
      initialResult ??= {
        provider: params.get("integration"),
        status: params.get("setup"),
        reason: params.get("reason"),
      };
      for (const key of ["integration", "setup", "reason"]) params.delete(key);
      const search = params.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`,
      );
    }
    if (initialResult) handlerRef.current(initialResult);

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string } | null;
      if (data?.type !== ONBOARDING_CONNECTION_MESSAGE) return;
      handlerRef.current(data as OnboardingConnectionResult);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
}
