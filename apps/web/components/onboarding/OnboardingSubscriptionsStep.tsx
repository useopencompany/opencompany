"use client";

import { Button } from "@opencompany/ui/components/button";
import { toast } from "@opencompany/ui/components/sonner";
import { AnthropicIcon, type LucideIcon, OpenAIIcon } from "@opencompany/ui/icons";
import { Check, Copy, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { saveClaudeCodeToken } from "@/lib/claude-code-auth";
import {
  type CodexDeviceAuthFlow,
  pollCodexDeviceAuth,
  startCodexDeviceAuth,
} from "@/lib/codex-auth";
import {
  getOnboardingSubscriptionsAction,
  type OnboardingSubscriptionsState,
} from "@/lib/onboarding-actions";

const CODEX_POLL_INTERVAL_MS = 2500;
const CLAUDE_SETUP_TOKEN_COMMAND = "claude setup-token";
const COPY_FEEDBACK_MS = 1500;

// Onboarding's take on the Inference settings cards: same two providers and the
// same auth mechanics, reduced to "connect or move on". Usage meters, workspace
// sharing, and disconnect live in Settings — none of them are first-run
// decisions.
export function OnboardingSubscriptionsStep({
  onConnectedCountChange,
}: {
  onConnectedCountChange: (count: number) => void;
}) {
  const [state, setState] = useState<OnboardingSubscriptionsState | null>(null);

  const refresh = async () => {
    setState(await getOnboardingSubscriptionsAction());
  };

  useEffect(() => {
    let active = true;
    void getOnboardingSubscriptionsAction().then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, []);

  const connectedCount = (state?.claudeCode.connected ? 1 : 0) + (state?.codex.connected ? 1 : 0);

  useEffect(() => {
    onConnectedCountChange(connectedCount);
  }, [connectedCount, onConnectedCountChange]);

  return (
    <div>
      <div className="mb-7 flex flex-col gap-2">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">
          Bring your own AI subscription
        </h1>
        <p className="text-[14px] leading-6 text-ink-muted">
          opencompany runs coding sandboxes for you — writing code, opening pull requests, and
          running tasks on your repos. Connecting a subscription you already pay for means that work
          runs on your plan instead of being billed per token.
        </p>
      </div>

      <div className="flex flex-col gap-2.5">
        <ClaudeCodeCard
          connected={state?.claudeCode.connected ?? false}
          needsReauth={state?.claudeCode.needsReauth ?? false}
          loading={state === null}
          onConnected={refresh}
        />
        <CodexCard
          connected={state?.codex.connected ?? false}
          needsReauth={state?.codex.needsReauth ?? false}
          loading={state === null}
          onConnected={refresh}
        />
      </div>

      <p className="mt-4 text-[12px] leading-5 text-ink-subtle">
        Your credentials are encrypted and only ever used for your own sandboxes. You can connect,
        change, or disconnect them later under Settings → Inference.
      </p>
    </div>
  );
}

function ProviderCard({
  icon: Icon,
  iconClassName,
  title,
  description,
  connected,
  needsReauth,
  loading,
  children,
  action,
}: {
  icon: LucideIcon;
  iconClassName: string;
  title: string;
  description: string;
  connected: boolean;
  needsReauth: boolean;
  loading: boolean;
  children?: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-3.5 py-3">
      <div className="flex items-start gap-3">
        <span
          className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${iconClassName}`}
        >
          <Icon className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium text-ink">{title}</span>
            {connected ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium leading-4 text-success">
                <Check size={11} strokeWidth={3} />
                Connected
              </span>
            ) : needsReauth ? (
              <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium leading-4 text-warning">
                Expired
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-[12px] leading-5 text-ink-subtle">{description}</p>
        </div>
        <div className="shrink-0">
          {loading ? (
            <Loader2 className="size-4 animate-spin text-ink-subtle" aria-label="Loading" />
          ) : (
            action
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

// The terminal command gets its own row so it reads as something to run and
// copy, rather than as a phrase buried in a sentence.
function CopyCommand({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      toast.error("Could not copy to your clipboard. Select the command and copy it manually.");
    }
  };

  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-muted px-3 py-2 font-mono text-[12px] text-ink">
        {value}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? "Command copied" : `Copy ${value}`}
        title="Copy command"
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

function ClaudeCodeCard({
  connected,
  needsReauth,
  loading,
  onConnected,
}: {
  connected: boolean;
  needsReauth: boolean;
  loading: boolean;
  onConnected: () => Promise<void>;
}) {
  const [showForm, setShowForm] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await saveClaudeCodeToken(token);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setToken("");
      setShowForm(false);
      await onConnected();
    });
  };

  return (
    <ProviderCard
      icon={AnthropicIcon}
      iconClassName="bg-[#CC785C] text-white"
      title="Claude"
      description="Runs your Claude Code sandboxes on your Claude subscription."
      connected={connected}
      needsReauth={needsReauth}
      loading={loading}
      action={
        connected ? null : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowForm((open) => !open)}
            className="h-8 rounded-full px-3 text-[12px] shadow-none"
          >
            {showForm ? "Cancel" : needsReauth ? "Reconnect" : "Connect"}
          </Button>
        )
      }
    >
      {showForm && !connected ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <p className="text-[12px] leading-5 text-ink-muted">Run this in your terminal:</p>
          <CopyCommand value={CLAUDE_SETUP_TOKEN_COMMAND} />
          <p className="text-[12px] leading-5 text-ink-muted">
            Approve it in the browser, then paste the token it prints here. Tokens last about a
            year.
          </p>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Paste your token (sk-ant-oat…)"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          />
          {error ? <p className="text-[12px] leading-4 text-warning">{error}</p> : null}
          <div>
            <Button
              size="sm"
              onClick={submit}
              disabled={isPending || !token.trim()}
              aria-busy={isPending}
              className="h-8 gap-1.5 rounded-full px-3 text-[12px] shadow-none"
            >
              {isPending ? <Loader2 className="animate-spin" /> : null}
              {isPending ? "Saving…" : "Save token"}
            </Button>
          </div>
        </div>
      ) : null}
    </ProviderCard>
  );
}

function CodexCard({
  connected,
  needsReauth,
  loading,
  onConnected,
}: {
  connected: boolean;
  needsReauth: boolean;
  loading: boolean;
  onConnected: () => Promise<void>;
}) {
  const [flow, setFlow] = useState<CodexDeviceAuthFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // The poll loop below is keyed on the flow alone, so it reads the latest
  // callback through a ref rather than restarting whenever the parent re-renders.
  const onConnectedRef = useRef(onConnected);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  // The device flow completes in the provider's tab, so the only way to learn
  // about it is to poll until it resolves.
  useEffect(() => {
    if (!flow || flow.status === "completed" || flow.status === "failed") return;
    if (flow.status === "expired") return;

    let active = true;
    let pollInFlight = false;
    const timer = window.setInterval(() => {
      if (pollInFlight) return;
      pollInFlight = true;
      void (async () => {
        try {
          const result = await pollCodexDeviceAuth(flow.id);
          if (!active) return;
          if (!result.ok) {
            setError(result.error);
            return;
          }
          if (result.flow.status === "completed") {
            setFlow(null);
            setError(null);
            await onConnectedRef.current();
          } else {
            setFlow(result.flow);
          }
        } finally {
          pollInFlight = false;
        }
      })();
    }, CODEX_POLL_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [flow]);

  const start = () => {
    setError(null);
    startTransition(async () => {
      const result = await startCodexDeviceAuth();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.flow.status === "completed") {
        setFlow(null);
        await onConnected();
        return;
      }
      setFlow(result.flow);
    });
  };

  const awaitingApproval = flow !== null && flow.status !== "failed" && flow.status !== "expired";

  return (
    <ProviderCard
      icon={OpenAIIcon}
      iconClassName="bg-black text-white"
      title="ChatGPT"
      description="Runs your Codex sandboxes on your ChatGPT subscription."
      connected={connected}
      needsReauth={needsReauth}
      loading={loading}
      action={
        connected ? null : (
          <Button
            variant="outline"
            size="sm"
            onClick={start}
            disabled={isPending || awaitingApproval}
            aria-busy={isPending || awaitingApproval}
            className="h-8 gap-1.5 rounded-full px-3 text-[12px] shadow-none"
          >
            {isPending || awaitingApproval ? <Loader2 className="animate-spin" /> : null}
            {awaitingApproval ? "Waiting…" : needsReauth ? "Reconnect" : "Connect"}
          </Button>
        )
      }
    >
      {flow?.status === "code_ready" && flow.verificationUri && flow.userCode ? (
        <div className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-[12px] leading-5 text-ink-muted">
          <a
            href={flow.verificationUri}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-ink underline underline-offset-2"
          >
            Open ChatGPT sign-in
          </a>
          <span> and enter </span>
          <span className="font-mono font-semibold text-ink">{flow.userCode}</span>
        </div>
      ) : null}
      {error || flow?.statusReason ? (
        <p className="text-[12px] leading-4 text-warning">{error ?? flow?.statusReason}</p>
      ) : null}
    </ProviderCard>
  );
}
