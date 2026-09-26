"use client";

import type { ActionProviderId } from "@opencompany/agent/actions/types";
import { Button } from "@opencompany/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { toast } from "@opencompany/ui/components/sonner";
import { cn } from "@opencompany/ui/lib/utils";
import { Check, Loader2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { type CapabilityMode, PROVIDER_CAPABILITIES } from "@/lib/actions/capabilities";
import { installOfficialPlugin, type OfficialMcpPluginConfig } from "@/lib/official-plugin-catalog";
import { getOnboardingInstalledPluginsAction } from "@/lib/onboarding-actions";
import {
  integrationConnectionError,
  ONBOARDING_CONNECTION_MESSAGE,
  ONBOARDING_CONNECTION_STORAGE_KEY,
  type OnboardingConnectionResult,
  onboardingConnectHref,
} from "@/lib/onboarding-integrations";

const CONNECT_POPUP_FEATURES = "width=600,height=760,noopener=no,noreferrer=no";

// API-key plugins connect on their plugin page, which only opens after onboarding. During setup
// they are installed now and finish connecting once the workspace is open.
export function connectsAfterOnboarding(config: OfficialMcpPluginConfig) {
  return !config.connectHref.startsWith("/api/integrations/");
}

// Installed plugin names and connected providers for the onboarding plugin steps, plus the
// permissions review every connection goes through first.
// The wizard owns this so the finish step can show what was added. Installed plugins are loaded
// once the workspace exists, which is when `loadInstalled` turns true.
export function usePluginConnections({ loadInstalled }: { loadInstalled: boolean }) {
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [connecting, setConnecting] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<OfficialMcpPluginConfig | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!loadInstalled) return;
    let active = true;
    void getOnboardingInstalledPluginsAction().then((names) => {
      if (active) setInstalled((current) => new Set([...current, ...names]));
    });
    return () => {
      active = false;
    };
  }, [loadInstalled]);

  const markConnected = useCallback((provider: string) => {
    setConnected((current) => new Set(current).add(provider));
  }, []);

  useConnectionResults((result) => {
    if (!result.provider) return;
    if (result.status === "connected") markConnected(result.provider);
    else if (result.status === "error") {
      toast.error(integrationConnectionError(result.provider, result.reason));
    }
  });

  // Runs from the dialog's confirm click: the popup must open synchronously inside a user
  // gesture, and installation runs alongside it so the two feel like one action.
  const confirm = () => {
    const config = reviewing;
    setReviewing(null);
    if (!config || isPending) return;
    const isInstalled = installed.has(config.name);
    // An account connected before (or API-key plugins) needs only the package installed now.
    const installOnly = connectsAfterOnboarding(config) || connected.has(config.connectionProvider);
    const href = installOnly ? null : onboardingConnectHref(config.connectHref);
    const popup = href ? window.open(href, "_blank", CONNECT_POPUP_FEATURES) : null;
    popup?.focus();

    if (isInstalled) {
      // Popup blocked: the connected route writes the result to localStorage and bounces back to
      // /onboarding, which resumes on this step via the cookie.
      if (href && !popup) window.location.assign(href);
      return;
    }

    setConnecting(config.name);
    startTransition(async () => {
      try {
        await installOfficialPlugin(config);
        setInstalled((current) => new Set(current).add(config.name));
        if (href && !popup) window.location.assign(href);
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

  return {
    installed,
    connected,
    connecting,
    disabled: isPending,
    markConnected,
    requestConnect: (config: OfficialMcpPluginConfig) => {
      if (!isPending) setReviewing(config);
    },
    dialog: (
      <ConnectPermissionsDialog
        config={reviewing}
        accountConnected={reviewing ? connected.has(reviewing.connectionProvider) : false}
        onCancel={() => setReviewing(null)}
        onConfirm={confirm}
      />
    ),
  };
}

export type PluginConnections = ReturnType<typeof usePluginConnections>;

const MODE_COPY: Record<CapabilityMode, { label: string; meaning: string; className: string }> = {
  on: {
    label: "On",
    meaning: "runs automatically",
    className: "border-success/25 bg-success/10 text-success",
  },
  ask: {
    label: "Ask",
    meaning: "waits for your approval in chat",
    className: "border-border-strong bg-surface-muted text-ink",
  },
  off: {
    label: "Off",
    meaning: "never available to your agent",
    className: "border-border bg-surface text-ink-subtle",
  },
};

export function ConnectPermissionsDialog({
  config,
  accountConnected,
  onCancel,
  onConfirm,
}: {
  config: OfficialMcpPluginConfig | null;
  accountConnected: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const capabilities = config
    ? (PROVIDER_CAPABILITIES[config.connectionProvider as ActionProviderId] ?? [])
    : [];
  const later = config ? connectsAfterOnboarding(config) : false;
  return (
    <Dialog open={config !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="max-w-[460px] gap-5">
        {config ? (
          <>
            <DialogHeader className="text-left">
              <span
                className={cn(
                  "mb-2 flex size-9 items-center justify-center rounded-lg border border-border/70",
                  config.iconClassName,
                )}
              >
                <config.Icon className="size-[18px]" />
              </span>
              <DialogTitle className="text-[15px]">Connect {config.label}</DialogTitle>
              <DialogDescription className="text-[12.5px] leading-5 text-ink-subtle">
                You decide what your agent can do with {config.label}. These are the defaults, and
                you can change them anytime in Plugins.
              </DialogDescription>
            </DialogHeader>

            {capabilities.length > 0 ? (
              <ul className="flex flex-col overflow-hidden rounded-xl border border-border">
                {capabilities.map((capability) => (
                  <li
                    key={capability.id}
                    className="flex items-center gap-3 border-border px-3.5 py-2.5 [&:not(:first-child)]:border-t"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-ink">{capability.label}</div>
                      <div className="truncate text-[11.5px] leading-4 text-ink-subtle">
                        {capability.description}
                      </div>
                    </div>
                    <ModeBadge mode={capability.defaultMode} />
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="flex flex-col gap-1.5 text-[12px] leading-5 text-ink-muted">
              {(["on", "ask", "off"] as const).map((mode) => (
                <div key={mode} className="flex items-center gap-2">
                  <ModeBadge mode={mode} />
                  <span>{MODE_COPY[mode].meaning}</span>
                </div>
              ))}
            </div>

            <p className="flex gap-2 rounded-lg bg-surface-muted px-3 py-2.5 text-[12px] leading-5 text-ink-muted">
              <ShieldCheck size={15} strokeWidth={2} className="mt-0.5 shrink-0 text-success" />
              <span>
                opencompany enforces these on every action. Off tools are never offered to your
                agent, and Ask tools can&apos;t run until you approve them.
              </span>
            </p>

            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={onCancel}>
                Cancel
              </Button>
              <Button size="sm" onClick={onConfirm} className="rounded-full px-4">
                {later || accountConnected ? `Add ${config.label}` : `Continue to ${config.label}`}
              </Button>
            </DialogFooter>
            {later ? (
              <p className="-mt-2 text-right text-[11.5px] text-ink-subtle">
                You&apos;ll add your {config.label} key from Plugins once setup is done.
              </p>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ModeBadge({ mode }: { mode: CapabilityMode }) {
  return (
    <span
      className={cn(
        "inline-flex w-11 shrink-0 justify-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4",
        MODE_COPY[mode].className,
      )}
    >
      {MODE_COPY[mode].label}
    </span>
  );
}

export function PluginRow({
  config,
  detail,
  recommended = false,
  installed,
  connected,
  connecting,
  disabled,
  onConnect,
}: {
  config: OfficialMcpPluginConfig;
  // Why this plugin is suggested, shown instead of the catalog description.
  detail?: string;
  recommended?: boolean;
  installed: boolean;
  connected: boolean;
  connecting: boolean;
  disabled: boolean;
  onConnect: (config: OfficialMcpPluginConfig) => void;
}) {
  const waitingForKey = installed && !connected && connectsAfterOnboarding(config);
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
        {detail ? (
          <p className="mt-0.5 truncate font-mono text-[11px] leading-5 text-ink-subtle">
            {detail}
          </p>
        ) : (
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-ink-subtle">
            {config.description}
          </p>
        )}
      </div>
      <div className="shrink-0">
        {installed && connected ? null : waitingForKey ? (
          <span className="text-[12px] text-ink-subtle">Key after setup</span>
        ) : (
          <Button
            variant={recommended && !installed ? "default" : "outline"}
            size="sm"
            disabled={disabled}
            aria-busy={connecting}
            onClick={() => onConnect(config)}
            className="h-8 gap-1.5 rounded-full px-3 text-[12px] shadow-none"
          >
            {connecting ? <Loader2 className="animate-spin" /> : null}
            {connecting
              ? "Connecting…"
              : connected || connectsAfterOnboarding(config)
                ? "Add"
                : "Connect"}
          </Button>
        )}
      </div>
    </div>
  );
}

// Connection results arrive either as a postMessage from the popup or, when the popup was blocked
// and the flow ran in this tab, as a localStorage record left behind by /onboarding/connected
// before it bounced back here.
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
      // Storage can be unavailable in privacy-restricted browser contexts. The postMessage path
      // below remains the primary connection-result channel.
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

    // When storage is blocked, the popup fallback returns the same result in the onboarding URL.
    // Consume it once, then remove only those callback parameters so refreshes do not replay a
    // stale result.
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
