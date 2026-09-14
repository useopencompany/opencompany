"use client";

import type { SandboxSize } from "@opencompany/core/sandbox-sizes";
import { toast } from "@opencompany/ui/components/sonner";
import { AnthropicIcon, OpenAIIcon } from "@opencompany/ui/icons";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState, useTransition } from "react";
import { disconnectClaudeCodeAuth, saveClaudeCodeToken } from "@/lib/claude-code-auth";
import {
  type CodexDeviceAuthFlow,
  disconnectCodexAuth,
  pollCodexDeviceAuth,
  setCodexWorkspaceEngineEnabled,
  startCodexDeviceAuth,
} from "@/lib/codex-auth";
import type { ClaudeCodeProviderState, CodexProviderState } from "@/lib/integration-state";
import { setWorkspaceSandboxSizeAction, type WorkspaceSandboxSizeResult } from "@/lib/sandbox-size";
import { formatUsdMicros } from "@/lib/usage-spend";

import { SubscriptionUsage } from "./SubscriptionUsage";

// One selectable machine size, with the hourly price computed from the same billing
// rates the sandbox meter charges (resolved on the server, where the rate table lives).
export type SandboxSizeOptionView = {
  size: SandboxSize;
  label: string;
  summary: string;
  cpuCount: number;
  memoryMB: number;
  hourlyCostUsdMicros: number;
};

export function InferenceSettingsPanel({
  codex,
  claudeCode,
  canManage,
  sandboxSize,
  sandboxSizeOptions,
}: {
  codex: CodexProviderState;
  claudeCode: ClaudeCodeProviderState;
  canManage: boolean;
  sandboxSize: WorkspaceSandboxSizeResult;
  sandboxSizeOptions: SandboxSizeOptionView[];
}) {
  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="coding-subscriptions-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="coding-subscriptions-heading" className="text-[15px] font-semibold text-ink">
            Coding subscriptions
          </h2>
          <p className="text-[13px] leading-5 text-ink-subtle">
            Connect your own subscriptions to run Codex and Claude Code sandboxes. Each teammate
            manages their own connections.
          </p>
        </div>
        <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
          <CodexSubscriptionCard integration={codex} />
          <ClaudeCodeSubscriptionCard integration={claudeCode} />
        </div>
      </section>

      <section aria-labelledby="workspace-model-access-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="workspace-model-access-heading" className="text-[15px] font-semibold text-ink">
            Workspace model access
          </h2>
          <p className="text-[13px] leading-5 text-ink-subtle">
            Choose whether shared AI models use workspace credits or an admin&apos;s subscription.
          </p>
        </div>
        <WorkspaceModelAccessCard integration={codex} canManage={canManage} />
      </section>

      <section aria-labelledby="sandbox-size-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="sandbox-size-heading" className="text-[15px] font-semibold text-ink">
            Sandbox size
          </h2>
          <p className="text-[13px] leading-5 text-ink-subtle">
            The machine every new cloud coding session runs on. Sandbox time is billed per second on
            the vCPU and memory it holds, so a smaller size costs less per hour.
          </p>
        </div>
        <SandboxSizeCard
          sandboxSize={sandboxSize}
          options={sandboxSizeOptions}
          canManage={canManage}
        />
      </section>
    </div>
  );
}

function SandboxSizeCard({
  sandboxSize,
  options,
  canManage,
}: {
  sandboxSize: WorkspaceSandboxSizeResult;
  options: SandboxSizeOptionView[];
  canManage: boolean;
}) {
  const [selected, setSelected] = useState<SandboxSize | null>(
    sandboxSize.ok ? sandboxSize.sandboxSize : null,
  );
  const [isPending, startTransition] = useTransition();

  if (!sandboxSize.ok) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <p className="text-[13px] leading-5 text-warning">{sandboxSize.error}</p>
      </div>
    );
  }

  const select = (next: SandboxSize) => {
    if (selected === next || isPending) return;
    const previous = selected;
    setSelected(next);
    startTransition(async () => {
      const result = await setWorkspaceSandboxSizeAction(next);
      if (result.ok) {
        setSelected(result.sandboxSize);
        toast.success(
          `New sessions will run on ${labelForSize(options, result.sandboxSize)}. Sessions already running keep their size.`,
        );
        return;
      }
      setSelected(previous);
      toast.error(result.error);
    });
  };

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <div className="flex flex-col gap-2">
        {options.map((option) => (
          <label
            key={option.size}
            className="flex cursor-pointer items-start gap-3 rounded-md border border-ink/10 p-3 has-[:disabled]:cursor-default"
          >
            <input
              type="radio"
              name="opencompany-workspace-sandbox-size"
              checked={selected === option.size}
              disabled={!canManage || isPending}
              onChange={() => select(option.size)}
              className="mt-0.5 accent-ink"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-medium text-ink">
                {option.label} · {option.cpuCount} vCPU · {option.memoryMB / 1024} GB
              </span>
              <span className="text-[12px] leading-5 text-ink-subtle">
                {option.summary} About {formatUsdMicros(option.hourlyCostUsdMicros)} per hour of
                running time.
              </span>
            </span>
          </label>
        ))}
      </div>
      <p className="text-[12px] leading-4 text-ink-subtle">
        {canManage
          ? "Sessions that are already running keep the size they started with."
          : "Managed by workspace admins."}
      </p>
    </div>
  );
}

function labelForSize(options: SandboxSizeOptionView[], size: SandboxSize) {
  return options.find((option) => option.size === size)?.label ?? size;
}

function SubscriptionCard({
  icon,
  iconClassName,
  title,
  description,
  body,
  footer,
}: {
  icon: ReactNode;
  iconClassName: string;
  title: string;
  description: string;
  body?: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <div
        className={`flex size-12 shrink-0 items-center justify-center rounded-full ${iconClassName}`}
      >
        {icon}
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-[15px] font-semibold leading-tight text-ink">{title}</h3>
        <p className="text-[13px] leading-5 text-ink-subtle">{description}</p>
      </div>
      {body}
      <div className="mt-auto pt-1">{footer}</div>
    </div>
  );
}

function CodexSubscriptionCard({ integration }: { integration: CodexProviderState }) {
  const router = useRouter();
  const [flow, setFlow] = useState<CodexDeviceAuthFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [isPending, startTransition] = useTransition();
  const status = flow?.status ?? integration.status;

  useEffect(() => {
    if (
      !flow ||
      flow.status === "completed" ||
      flow.status === "failed" ||
      flow.status === "expired"
    ) {
      return;
    }

    let active = true;
    let pollInFlight = false;
    const timer = window.setInterval(() => {
      if (pollInFlight) return;
      pollInFlight = true;
      setIsPolling(true);
      void (async () => {
        try {
          const result = await pollCodexDeviceAuth(flow.id);
          if (!active) return;
          if (result.ok) {
            if (result.flow.status === "completed") {
              setFlow(null);
              setError(null);
              router.refresh();
            } else {
              setFlow(result.flow);
            }
          } else {
            setError(result.error);
          }
        } finally {
          pollInFlight = false;
          if (active) setIsPolling(false);
        }
      })();
    }, 2500);

    return () => {
      active = false;
      window.clearInterval(timer);
      setIsPolling(false);
    };
  }, [flow, router]);

  const startAuth = () => {
    setError(null);
    startTransition(async () => {
      const result = await startCodexDeviceAuth();
      if (result.ok) {
        if (result.flow.status === "completed") {
          setFlow(null);
          router.refresh();
        } else {
          setFlow(result.flow);
        }
      } else {
        setError(result.error);
      }
    });
  };

  const disconnect = () => {
    setError(null);
    setIsPolling(false);
    startTransition(async () => {
      await disconnectCodexAuth();
      setFlow(null);
      router.refresh();
    });
  };

  const accountLabel =
    integration.status === "connected"
      ? integration.lastValidatedAt
        ? `Validated ${formatDateTime(integration.lastValidatedAt)}`
        : "Subscription connected"
      : integration.statusReason;

  return (
    <SubscriptionCard
      icon={<OpenAIIcon size={24} />}
      iconClassName="bg-black text-white"
      title="Codex"
      description="Use your ChatGPT subscription for your Codex sandboxes."
      body={
        <div className="flex flex-col gap-2">
          {accountLabel ? (
            <p className="truncate text-[12px] leading-4 text-ink-subtle">{accountLabel}</p>
          ) : null}
          {flow?.status === "code_ready" && flow.verificationUri && flow.userCode ? (
            <div className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-[12px] leading-5 text-ink-muted">
              <a
                href={flow.verificationUri}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-ink underline underline-offset-2"
              >
                Open Codex sign-in
              </a>
              <span> and enter </span>
              <span className="font-mono font-semibold text-ink">{flow.userCode}</span>
            </div>
          ) : null}
          {flow?.statusReason || error ? (
            <p className="text-[12px] leading-4 text-warning">{error ?? flow?.statusReason}</p>
          ) : null}
          {integration.connected && !flow ? (
            <SubscriptionUsage key={integration.lastValidatedAt ?? "connected"} provider="codex" />
          ) : null}
        </div>
      }
      footer={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={startAuth}
            disabled={isPending}
            aria-busy={isPending || isPolling}
            className="inline-flex items-center justify-center rounded-full border border-border px-4 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-60"
          >
            {connectionButtonLabel(status, isPending)}
          </button>
          {integration.connected ? (
            <button
              type="button"
              onClick={disconnect}
              disabled={isPending}
              className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[13px] font-medium text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:opacity-60"
            >
              Disconnect
            </button>
          ) : null}
        </div>
      }
    />
  );
}

function ClaudeCodeSubscriptionCard({ integration }: { integration: ClaudeCodeProviderState }) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submitToken = () => {
    setError(null);
    startTransition(async () => {
      const result = await saveClaudeCodeToken(token);
      if (result.ok) {
        setToken("");
        setShowForm(false);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  const disconnect = () => {
    setError(null);
    startTransition(async () => {
      await disconnectClaudeCodeAuth();
      setShowForm(false);
      router.refresh();
    });
  };

  const accountLabel =
    integration.status === "connected"
      ? integration.lastValidatedAt
        ? `Validated ${formatDateTime(integration.lastValidatedAt)}`
        : "Token saved; validation pending"
      : integration.statusReason;

  return (
    <SubscriptionCard
      icon={<AnthropicIcon size={24} />}
      iconClassName="bg-[#CC785C] text-white"
      title="Claude Code"
      description="Use your Claude subscription for your Claude Code sandboxes."
      body={
        <div className="flex flex-col gap-2">
          {accountLabel ? (
            <p className="truncate text-[12px] leading-4 text-ink-subtle">{accountLabel}</p>
          ) : null}
          {showForm ? (
            <div className="flex flex-col gap-2">
              <p className="text-[12px] leading-5 text-ink-muted">
                Run <span className="font-mono font-semibold text-ink">claude setup-token</span> on
                your machine, approve in the browser, and paste the token here. Tokens last about a
                year.
              </p>
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="sk-ant-oat…"
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              />
            </div>
          ) : null}
          {error ? <p className="text-[12px] leading-4 text-warning">{error}</p> : null}
          {integration.connected && !showForm ? (
            <SubscriptionUsage
              key={integration.lastValidatedAt ?? "connected"}
              provider="claude_code"
            />
          ) : null}
        </div>
      }
      footer={
        <div className="flex items-center gap-2">
          {showForm ? (
            <>
              <button
                type="button"
                onClick={submitToken}
                disabled={isPending || !token.trim()}
                aria-busy={isPending}
                className="inline-flex items-center justify-center rounded-full border border-border px-4 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-60"
              >
                {isPending ? "Working" : "Save token"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setToken("");
                  setError(null);
                }}
                disabled={isPending}
                className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[13px] font-medium text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:opacity-60"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setShowForm(true)}
                disabled={isPending}
                className="inline-flex items-center justify-center rounded-full border border-border px-4 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-60"
              >
                {connectionButtonLabel(integration.status, isPending)}
              </button>
              {integration.connected ? (
                <button
                  type="button"
                  onClick={disconnect}
                  disabled={isPending}
                  className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[13px] font-medium text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:opacity-60"
                >
                  Disconnect
                </button>
              ) : null}
            </>
          )}
        </div>
      }
    />
  );
}

function WorkspaceModelAccessCard({
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
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <div className="flex items-start gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-black text-white">
          <OpenAIIcon size={24} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="text-[15px] font-semibold leading-tight text-ink">Shared model access</h3>
          <p className="text-[13px] leading-5 text-ink-subtle">
            Let everyone use GPT 5.6 Sol and Terra through one admin&apos;s ChatGPT subscription.
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-1 text-[12px] leading-4 text-ink-subtle">
        {account ? (
          <p>
            {enabled ? "Enabled" : "Disabled"} · {account.providerDisplayName} (
            {account.providerEmail})
          </p>
        ) : (
          <p>Using metered workspace credits.</p>
        )}
        {account?.credentialStatus === "needs_reauth" ? (
          <p className="text-warning">
            {account.credentialStatusReason ?? "The provider must reconnect Codex."}
          </p>
        ) : null}
        {!enabled && canManage && !canEnable ? (
          <p>Connect Codex above to share your subscription with the workspace.</p>
        ) : null}
        {!canManage ? <p>Managed by workspace admins.</p> : null}
        {error ? <p className="text-warning">{error}</p> : null}
      </div>
      {canManage ? (
        <div className="pt-1">
          <button
            type="button"
            onClick={update}
            disabled={isPending || (!enabled && !canEnable)}
            aria-busy={isPending}
            className="inline-flex items-center justify-center rounded-full border border-border px-4 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover disabled:opacity-60"
          >
            {isPending ? "Updating" : enabled ? "Disable shared access" : "Share my subscription"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function connectionButtonLabel(status: string, isPending: boolean) {
  if (isPending) return "Working";
  if (status === "connected" || status === "needs_reauth") return "Reconnect";
  if (status === "failed" || status === "expired") return "Retry";
  return "Connect";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
