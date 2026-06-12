"use client";

import {
  AlertTriangle,
  BarChart3,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  FlaskConical,
  GitBranch,
  KeyRound,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  Plug,
  Sun,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { type BillingData, BillingPanel } from "@/components/billing/BillingPanel";
import { type ThemeMode, useTheme } from "@/components/ThemeProvider";
import { ToolPolicyEditor } from "@/components/ToolPolicyEditor";
import {
  removeBetterStackMcpConnection,
  removeBraintrustMcpConnection,
  removeLinearMcpToken,
  removeNotionMcpConnection,
  removePostHogMcpConnection,
  removeSlackMcpConnection,
  saveLinearMcpToken,
} from "@/lib/mcp/actions";
import type { WorkspaceToolPolicyOverrides } from "@/lib/tool-policies/data";
import { removeAvatar, updateAvatar } from "@/lib/users/actions";
import { updateWorkspaceName } from "@/lib/workspaces/actions";

const LINEAR_API_KEYS_URL = "https://linear.app/settings/account/security";
const LINEAR_MCP_DOCS_URL = "https://linear.app/docs/mcp";
const LINEAR_MCP_START_URL = "/api/mcp/linear/start?returnTo=/company/settings";
const SLACK_MCP_DOCS_URL = "https://docs.slack.dev/ai/slack-mcp-server/";
const SLACK_MCP_START_URL = "/api/mcp/slack/start?returnTo=/company/settings";
const POSTHOG_MCP_DOCS_URL = "https://posthog.com/docs/model-context-protocol";
const POSTHOG_MCP_START_URL = "/api/mcp/posthog/start?returnTo=/company/settings";
const BETTERSTACK_MCP_DOCS_URL = "https://betterstack.com/docs/getting-started/integrations/mcp/";
const BETTERSTACK_MCP_START_URL = "/api/mcp/betterstack/start?returnTo=/company/settings";
const BRAINTRUST_MCP_DOCS_URL = "https://www.braintrust.dev/docs/integrations/developer-tools/mcp";
const BRAINTRUST_MCP_START_URL = "/api/mcp/braintrust/start?returnTo=/company/settings";
const NOTION_MCP_DOCS_URL = "https://developers.notion.com/guides/mcp/overview";
const NOTION_MCP_START_URL = "/api/mcp/notion/start?returnTo=/company/settings";

type Props = {
  profile: {
    name: string;
    email: string;
    avatarUrl: string | null;
    hasCustomAvatar: boolean;
    initials: string;
  };
  workspace: {
    name: string;
    createdAt: string;
    sync: {
      hasRepo: boolean;
      lastSyncedAt: string | null;
      pendingCount: number;
      failedCount: number;
    };
  };
  billing: BillingData;
  mcp: {
    linear: {
      configured: boolean;
      status: "configured" | "missing_credential" | "disabled" | "error" | null;
      statusReason: string | null;
      updatedAt: string | null;
    };
    slack: {
      configured: boolean;
      status: "configured" | "missing_credential" | "disabled" | "error" | null;
      statusReason: string | null;
      updatedAt: string | null;
    };
    posthog: {
      configured: boolean;
      status: "configured" | "missing_credential" | "disabled" | "error" | null;
      statusReason: string | null;
      updatedAt: string | null;
    };
    betterstack: {
      configured: boolean;
      status: "configured" | "missing_credential" | "disabled" | "error" | null;
      statusReason: string | null;
      updatedAt: string | null;
    };
    braintrust: {
      configured: boolean;
      status: "configured" | "missing_credential" | "disabled" | "error" | null;
      statusReason: string | null;
      updatedAt: string | null;
    };
    notion: {
      configured: boolean;
      status: "configured" | "missing_credential" | "disabled" | "error" | null;
      statusReason: string | null;
      updatedAt: string | null;
    };
  };
  toolPolicies: WorkspaceToolPolicyOverrides;
};

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-border-subtle py-7 first:border-t-0 first:pt-0">
      <div className="grid grid-cols-[200px_1fr] gap-8">
        <div>
          <h2 className="text-[13px] font-semibold tracking-[-0.005em] text-ink">{title}</h2>
          {description && (
            <p className="mt-1 text-[12px] leading-5 text-ink-muted">{description}</p>
          )}
        </div>
        <div className="flex flex-col gap-4">{children}</div>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
        {label}
      </div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function ReadOnly({ value }: { value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface/60 px-2.5 py-1.5 text-[13px] text-ink/85">
      {value}
    </div>
  );
}

const themeOptions: Array<{
  value: ThemeMode;
  label: string;
  icon: typeof Monitor;
}> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

function AppearanceSection() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      className="inline-flex w-fit rounded-lg border border-border bg-surface p-1 shadow-[0_1px_2px_rgba(15,15,15,0.03)]"
      role="radiogroup"
      aria-label="Theme"
    >
      {themeOptions.map((option) => {
        const Icon = option.icon;
        const selected = theme === option.value;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(option.value)}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
              selected
                ? "bg-surface-active text-ink shadow-[0_1px_1px_rgba(15,15,15,0.05)]"
                : "text-ink-muted hover:bg-surface-hover hover:text-ink"
            }`}
          >
            <Icon size={13} strokeWidth={1.9} />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function WorkspaceState({ sync }: { sync: Props["workspace"]["sync"] }) {
  const failed = sync.failedCount > 0;
  const pending = sync.pendingCount > 0;

  return (
    <div className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
          <GitBranch size={15} strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">
            Managed by opencompany through Git
          </div>
          <p className="mt-1 text-[12px] leading-5 text-ink-muted">
            Your workspace files are versioned automatically in a private Git-backed repository.
          </p>

          <div className="mt-3 flex items-center gap-1.5 text-[12px]">
            {failed ? (
              <>
                <AlertTriangle size={13} strokeWidth={1.8} className="shrink-0 text-danger" />
                <span className="font-medium text-danger">
                  {sync.failedCount} change{sync.failedCount === 1 ? "" : "s"} failed to sync —
                  retrying
                </span>
              </>
            ) : pending ? (
              <>
                <Clock size={13} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
                <span className="text-ink-muted">
                  {sync.pendingCount} change{sync.pendingCount === 1 ? "" : "s"} waiting to sync
                </span>
              </>
            ) : (
              <>
                <CheckCircle2 size={13} strokeWidth={1.8} className="shrink-0 text-success" />
                <span className="text-ink-muted">In sync</span>
              </>
            )}
          </div>

          <div className="mt-3 text-[11.5px] text-ink-subtle">
            {sync.hasRepo
              ? sync.lastSyncedAt
                ? `Last synced ${sync.lastSyncedAt}`
                : "Not synced yet"
              : "Git storage is being set up"}
          </div>
        </div>
      </div>
    </div>
  );
}

function McpServersSection({
  mcp,
  toolPolicies,
}: {
  mcp: Props["mcp"];
  toolPolicies: WorkspaceToolPolicyOverrides;
}) {
  const searchParams = useSearchParams();
  const linearSetupStatus = searchParams.get("mcp") === "linear" ? searchParams.get("setup") : null;
  const normalizedLinearSetupStatus =
    linearSetupStatus === "connected" || linearSetupStatus === "error" ? linearSetupStatus : null;
  const linearSetupReason =
    searchParams.get("mcp") === "linear" ? searchParams.get("reason") : null;
  const slackSetupStatus = searchParams.get("mcp") === "slack" ? searchParams.get("setup") : null;
  const normalizedSlackSetupStatus =
    slackSetupStatus === "connected" || slackSetupStatus === "error" ? slackSetupStatus : null;
  const slackSetupReason = searchParams.get("mcp") === "slack" ? searchParams.get("reason") : null;
  const posthogSetupStatus =
    searchParams.get("mcp") === "posthog" ? searchParams.get("setup") : null;
  const normalizedPosthogSetupStatus =
    posthogSetupStatus === "connected" || posthogSetupStatus === "error"
      ? posthogSetupStatus
      : null;
  const posthogSetupReason =
    searchParams.get("mcp") === "posthog" ? searchParams.get("reason") : null;
  const betterstackSetupStatus =
    searchParams.get("mcp") === "betterstack" ? searchParams.get("setup") : null;
  const normalizedBetterStackSetupStatus =
    betterstackSetupStatus === "connected" || betterstackSetupStatus === "error"
      ? betterstackSetupStatus
      : null;
  const betterstackSetupReason =
    searchParams.get("mcp") === "betterstack" ? searchParams.get("reason") : null;
  const braintrustSetupStatus =
    searchParams.get("mcp") === "braintrust" ? searchParams.get("setup") : null;
  const normalizedBraintrustSetupStatus =
    braintrustSetupStatus === "connected" || braintrustSetupStatus === "error"
      ? braintrustSetupStatus
      : null;
  const braintrustSetupReason =
    searchParams.get("mcp") === "braintrust" ? searchParams.get("reason") : null;
  const notionSetupStatus = searchParams.get("mcp") === "notion" ? searchParams.get("setup") : null;
  const normalizedNotionSetupStatus =
    notionSetupStatus === "connected" || notionSetupStatus === "error" ? notionSetupStatus : null;
  const notionSetupReason =
    searchParams.get("mcp") === "notion" ? searchParams.get("reason") : null;

  return (
    <div className="space-y-3">
      <LinearMcpCard
        linear={mcp.linear}
        setupStatus={normalizedLinearSetupStatus}
        setupReason={linearSetupReason}
        policyOverrides={toolPolicies.linear}
      />
      <SlackMcpCard
        slack={mcp.slack}
        setupStatus={normalizedSlackSetupStatus}
        setupReason={slackSetupReason}
        policyOverrides={toolPolicies.slack}
      />
      <PostHogMcpCard
        posthog={mcp.posthog}
        setupStatus={normalizedPosthogSetupStatus}
        setupReason={posthogSetupReason}
        policyOverrides={toolPolicies.posthog}
      />
      <BetterStackMcpCard
        betterstack={mcp.betterstack}
        setupStatus={normalizedBetterStackSetupStatus}
        setupReason={betterstackSetupReason}
        policyOverrides={toolPolicies.betterstack}
      />
      <BraintrustMcpCard
        braintrust={mcp.braintrust}
        setupStatus={normalizedBraintrustSetupStatus}
        setupReason={braintrustSetupReason}
        policyOverrides={toolPolicies.braintrust}
      />
      <NotionMcpCard
        notion={mcp.notion}
        setupStatus={normalizedNotionSetupStatus}
        setupReason={notionSetupReason}
        policyOverrides={toolPolicies.notion}
      />
    </div>
  );
}

function LinearMcpCard({
  linear,
  setupStatus,
  setupReason,
  policyOverrides,
}: {
  linear: Props["mcp"]["linear"];
  setupStatus: "connected" | "error" | null;
  setupReason: string | null;
  policyOverrides: WorkspaceToolPolicyOverrides[string] | undefined;
}) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [dismissedSetupStatus, setDismissedSetupStatus] = useState<"connected" | "error" | null>(
    null,
  );
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const configured = linear.configured;
  const setupMessage =
    setupStatus && setupStatus !== dismissedSetupStatus
      ? {
          type: setupStatus === "connected" ? ("success" as const) : ("error" as const),
          text:
            setupStatus === "connected"
              ? "Linear connected."
              : linearMcpSetupErrorMessage(setupReason),
        }
      : null;
  const visibleMessage = message ?? setupMessage;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setMessage(null);
        setDismissedSetupStatus(setupStatus);
        startTransition(async () => {
          const result = await saveLinearMcpToken(token);
          if (result.ok) {
            setToken("");
            setMessage({ type: "success", text: "Linear MCP token saved." });
            router.refresh();
            return;
          }
          setMessage({ type: "error", text: result.error });
        });
      }}
      className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
            <KeyRound size={15} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">Linear MCP</div>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${
                  configured
                    ? "border-success-border bg-success-bg text-success"
                    : "border-warning-border bg-warning-bg text-warning"
                }`}
              >
                {configured ? "Configured" : "Not connected"}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-5 text-ink-muted">
              Agents can opt in with @linear after Linear is connected.
            </p>
            {linear.statusReason ? (
              <p className="mt-1 text-[11.5px] leading-4 text-ink-subtle">{linear.statusReason}</p>
            ) : null}
          </div>
        </div>
        {configured ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              setMessage(null);
              setDismissedSetupStatus(setupStatus);
              startTransition(async () => {
                const result = await removeLinearMcpToken();
                if (result.ok) {
                  setMessage({ type: "success", text: "Linear MCP token removed." });
                  router.refresh();
                }
              });
            }}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={13} strokeWidth={1.9} />
            Remove
          </button>
        ) : null}
      </div>
      <div className="mt-4 border-t border-border-subtle pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={LINEAR_MCP_START_URL}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85"
          >
            <ExternalLink size={13} strokeWidth={1.9} />
            {configured ? "Reconnect Linear" : "Connect Linear"}
          </a>
          <a
            href={LINEAR_MCP_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-muted hover:text-ink"
          >
            MCP docs
            <ExternalLink size={12} strokeWidth={1.9} />
          </a>
        </div>
        <details className="mt-3">
          <summary className="cursor-pointer list-none text-[12px] font-medium text-ink-muted transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
            Use a Linear API key instead
          </summary>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <a
              href={LINEAR_API_KEYS_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted"
            >
              <ExternalLink size={13} strokeWidth={1.9} />
              Create Linear API key
            </a>
            <div className="flex min-w-[240px] flex-1 items-center gap-2">
              <input
                value={token}
                onChange={(event) => {
                  setToken(event.target.value);
                  setMessage(null);
                  setDismissedSetupStatus(setupStatus);
                }}
                placeholder={
                  configured ? "Paste a new token to replace it" : "Linear API key or OAuth token"
                }
                type="password"
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-ink/30 focus:ring-1 focus:ring-ink/15"
              />
              <button
                type="submit"
                disabled={isPending || !token.trim()}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isPending ? "Saving..." : configured ? "Replace" : "Save"}
              </button>
            </div>
          </div>
        </details>
      </div>
      {visibleMessage && (
        <div
          className={`mt-2 text-[12px] ${
            visibleMessage.type === "success" ? "text-success" : "text-danger"
          }`}
        >
          {visibleMessage.text}
        </div>
      )}
      {configured ? <ToolPolicyEditor providerKey="linear" overrides={policyOverrides} /> : null}
    </form>
  );
}

function SlackMcpCard({
  slack,
  setupStatus,
  setupReason,
  policyOverrides,
}: {
  slack: Props["mcp"]["slack"];
  setupStatus: "connected" | "error" | null;
  setupReason: string | null;
  policyOverrides: WorkspaceToolPolicyOverrides[string] | undefined;
}) {
  const router = useRouter();
  const [dismissedSetupStatus, setDismissedSetupStatus] = useState<"connected" | "error" | null>(
    null,
  );
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const configured = slack.configured;
  const setupMessage =
    setupStatus && setupStatus !== dismissedSetupStatus
      ? {
          type: setupStatus === "connected" ? ("success" as const) : ("error" as const),
          text:
            setupStatus === "connected"
              ? "Slack connected."
              : slackMcpSetupErrorMessage(setupReason),
        }
      : null;
  const visibleMessage = message ?? setupMessage;

  return (
    <div className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
            <MessageSquare size={15} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">Slack MCP</div>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${
                  configured
                    ? "border-success-border bg-success-bg text-success"
                    : "border-warning-border bg-warning-bg text-warning"
                }`}
              >
                {configured ? "Configured" : "Not connected"}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-5 text-ink-muted">
              Agents can opt in with @slack after Slack is connected.
            </p>
            {slack.statusReason ? (
              <p className="mt-1 text-[11.5px] leading-4 text-ink-subtle">{slack.statusReason}</p>
            ) : null}
          </div>
        </div>
        {configured ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              setMessage(null);
              setDismissedSetupStatus(setupStatus);
              startTransition(async () => {
                const result = await removeSlackMcpConnection();
                if (result.ok) {
                  setMessage({ type: "success", text: "Slack MCP connection removed." });
                  router.refresh();
                }
              });
            }}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={13} strokeWidth={1.9} />
            Remove
          </button>
        ) : null}
      </div>
      <div className="mt-4 border-t border-border-subtle pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={SLACK_MCP_START_URL}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85"
          >
            <ExternalLink size={13} strokeWidth={1.9} />
            {configured ? "Reconnect Slack" : "Connect Slack"}
          </a>
          <a
            href={SLACK_MCP_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-muted hover:text-ink"
          >
            MCP docs
            <ExternalLink size={12} strokeWidth={1.9} />
          </a>
        </div>
      </div>
      {visibleMessage && (
        <div
          className={`mt-2 text-[12px] ${
            visibleMessage.type === "success" ? "text-success" : "text-danger"
          }`}
        >
          {visibleMessage.text}
        </div>
      )}
      {configured ? <ToolPolicyEditor providerKey="slack" overrides={policyOverrides} /> : null}
    </div>
  );
}

function PostHogMcpCard({
  posthog,
  setupStatus,
  setupReason,
  policyOverrides,
}: {
  posthog: Props["mcp"]["posthog"];
  setupStatus: "connected" | "error" | null;
  setupReason: string | null;
  policyOverrides: WorkspaceToolPolicyOverrides[string] | undefined;
}) {
  const router = useRouter();
  const [dismissedSetupStatus, setDismissedSetupStatus] = useState<"connected" | "error" | null>(
    null,
  );
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const configured = posthog.configured;
  const setupMessage =
    setupStatus && setupStatus !== dismissedSetupStatus
      ? {
          type: setupStatus === "connected" ? ("success" as const) : ("error" as const),
          text:
            setupStatus === "connected"
              ? "PostHog connected."
              : posthogMcpSetupErrorMessage(setupReason),
        }
      : null;
  const visibleMessage = message ?? setupMessage;

  return (
    <div className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
            <BarChart3 size={15} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">
                PostHog MCP
              </div>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${
                  configured
                    ? "border-success-border bg-success-bg text-success"
                    : "border-warning-border bg-warning-bg text-warning"
                }`}
              >
                {configured ? "Configured" : "Not connected"}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-5 text-ink-muted">
              Agents can opt in with @posthog after PostHog is connected.
            </p>
            {posthog.statusReason ? (
              <p className="mt-1 text-[11.5px] leading-4 text-ink-subtle">{posthog.statusReason}</p>
            ) : null}
          </div>
        </div>
        {configured ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              setMessage(null);
              setDismissedSetupStatus(setupStatus);
              startTransition(async () => {
                const result = await removePostHogMcpConnection();
                if (result.ok) {
                  setMessage({ type: "success", text: "PostHog MCP connection removed." });
                  router.refresh();
                }
              });
            }}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={13} strokeWidth={1.9} />
            Remove
          </button>
        ) : null}
      </div>
      <div className="mt-4 border-t border-border-subtle pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={POSTHOG_MCP_START_URL}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85"
          >
            <ExternalLink size={13} strokeWidth={1.9} />
            {configured ? "Reconnect PostHog" : "Connect PostHog"}
          </a>
          <a
            href={POSTHOG_MCP_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-muted hover:text-ink"
          >
            MCP docs
            <ExternalLink size={12} strokeWidth={1.9} />
          </a>
        </div>
      </div>
      {visibleMessage && (
        <div
          className={`mt-2 text-[12px] ${
            visibleMessage.type === "success" ? "text-success" : "text-danger"
          }`}
        >
          {visibleMessage.text}
        </div>
      )}
      {configured ? <ToolPolicyEditor providerKey="posthog" overrides={policyOverrides} /> : null}
    </div>
  );
}

function BetterStackMcpCard({
  betterstack,
  setupStatus,
  setupReason,
  policyOverrides,
}: {
  betterstack: Props["mcp"]["betterstack"];
  setupStatus: "connected" | "error" | null;
  setupReason: string | null;
  policyOverrides: WorkspaceToolPolicyOverrides[string] | undefined;
}) {
  const router = useRouter();
  const [dismissedSetupStatus, setDismissedSetupStatus] = useState<"connected" | "error" | null>(
    null,
  );
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const configured = betterstack.configured;
  const setupMessage =
    setupStatus && setupStatus !== dismissedSetupStatus
      ? {
          type: setupStatus === "connected" ? ("success" as const) : ("error" as const),
          text:
            setupStatus === "connected"
              ? "Better Stack connected."
              : betterstackMcpSetupErrorMessage(setupReason),
        }
      : null;
  const visibleMessage = message ?? setupMessage;

  return (
    <div className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
            <Monitor size={15} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">
                Better Stack MCP
              </div>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${
                  configured
                    ? "border-success-border bg-success-bg text-success"
                    : "border-warning-border bg-warning-bg text-warning"
                }`}
              >
                {configured ? "Configured" : "Not connected"}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-5 text-ink-muted">
              Agents can opt in with @betterstack after Better Stack is connected.
            </p>
            {betterstack.statusReason ? (
              <p className="mt-1 text-[11.5px] leading-4 text-ink-subtle">
                {betterstack.statusReason}
              </p>
            ) : null}
          </div>
        </div>
        {configured ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              setMessage(null);
              setDismissedSetupStatus(setupStatus);
              startTransition(async () => {
                const result = await removeBetterStackMcpConnection();
                if (result.ok) {
                  setMessage({ type: "success", text: "Better Stack MCP connection removed." });
                  router.refresh();
                }
              });
            }}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={13} strokeWidth={1.9} />
            Remove
          </button>
        ) : null}
      </div>
      <div className="mt-4 border-t border-border-subtle pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={BETTERSTACK_MCP_START_URL}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85"
          >
            <ExternalLink size={13} strokeWidth={1.9} />
            {configured ? "Reconnect Better Stack" : "Connect Better Stack"}
          </a>
          <a
            href={BETTERSTACK_MCP_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-muted hover:text-ink"
          >
            MCP docs
            <ExternalLink size={12} strokeWidth={1.9} />
          </a>
        </div>
      </div>
      {visibleMessage && (
        <div
          className={`mt-2 text-[12px] ${
            visibleMessage.type === "success" ? "text-success" : "text-danger"
          }`}
        >
          {visibleMessage.text}
        </div>
      )}
      {configured ? (
        <ToolPolicyEditor providerKey="betterstack" overrides={policyOverrides} />
      ) : null}
    </div>
  );
}

function linearMcpSetupErrorMessage(reason: string | null) {
  switch (reason) {
    case "invalid_state":
      return "Linear connection expired or was started in another browser tab. Try reconnecting Linear.";
    case "session_mismatch":
      return "Linear returned to a different OpenCompany session. Sign in to the same workspace and try again.";
    case "linear_denied":
      return "Linear did not authorize the connection.";
    case "missing_code":
      return "Linear did not return an authorization code. Try reconnecting Linear.";
    case "token_exchange_failed":
      return "Linear authorized the connection, but token exchange failed. Check the server logs and try again.";
    case "start_failed":
      return "Could not start Linear authorization. Check the server logs and try again.";
    default:
      return "Linear connection failed. Try reconnecting Linear.";
  }
}

function slackMcpSetupErrorMessage(reason: string | null) {
  switch (reason) {
    case "invalid_state":
      return "Slack connection expired or was started in another browser tab. Try reconnecting Slack.";
    case "session_mismatch":
      return "Slack returned to a different OpenCompany session. Sign in to the same workspace and try again.";
    case "slack_denied":
      return "Slack did not authorize the connection.";
    case "missing_code":
      return "Slack did not return an authorization code. Try reconnecting Slack.";
    case "token_exchange_failed":
      return "Slack authorized the connection, but token exchange failed. Check the server logs and try again.";
    case "start_failed":
      return "Could not start Slack authorization. Check SLACK_MCP_CLIENT_ID and SLACK_MCP_CLIENT_SECRET, then try again.";
    default:
      return "Slack connection failed. Try reconnecting Slack.";
  }
}

function posthogMcpSetupErrorMessage(reason: string | null) {
  switch (reason) {
    case "invalid_state":
      return "PostHog connection expired or was started in another browser tab. Try reconnecting PostHog.";
    case "session_mismatch":
      return "PostHog returned to a different OpenCompany session. Sign in to the same workspace and try again.";
    case "posthog_denied":
      return "PostHog did not authorize the connection.";
    case "missing_code":
      return "PostHog did not return an authorization code. Try reconnecting PostHog.";
    case "token_exchange_failed":
      return "PostHog authorized the connection, but token exchange failed. Check the server logs and try again.";
    case "start_failed":
      return "Could not start PostHog authorization. Check the server logs and try again.";
    default:
      return "PostHog connection failed. Try reconnecting PostHog.";
  }
}

function betterstackMcpSetupErrorMessage(reason: string | null) {
  switch (reason) {
    case "invalid_state":
      return "Better Stack connection expired or was started in another browser tab. Try reconnecting Better Stack.";
    case "session_mismatch":
      return "Better Stack returned to a different OpenCompany session. Sign in to the same workspace and try again.";
    case "betterstack_denied":
      return "Better Stack did not authorize the connection.";
    case "missing_code":
      return "Better Stack did not return an authorization code. Try reconnecting Better Stack.";
    case "token_exchange_failed":
      return "Better Stack authorized the connection, but token exchange failed. Check the server logs and try again.";
    case "start_failed":
      return "Could not start Better Stack authorization. Check the server logs and try again.";
    default:
      return "Better Stack connection failed. Try reconnecting Better Stack.";
  }
}

function BraintrustMcpCard({
  braintrust,
  setupStatus,
  setupReason,
  policyOverrides,
}: {
  braintrust: Props["mcp"]["braintrust"];
  setupStatus: "connected" | "error" | null;
  setupReason: string | null;
  policyOverrides: WorkspaceToolPolicyOverrides[string] | undefined;
}) {
  const router = useRouter();
  const [dismissedSetupStatus, setDismissedSetupStatus] = useState<"connected" | "error" | null>(
    null,
  );
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const configured = braintrust.configured;
  const setupMessage =
    setupStatus && setupStatus !== dismissedSetupStatus
      ? {
          type: setupStatus === "connected" ? ("success" as const) : ("error" as const),
          text:
            setupStatus === "connected"
              ? "Braintrust connected."
              : braintrustMcpSetupErrorMessage(setupReason),
        }
      : null;
  const visibleMessage = message ?? setupMessage;

  return (
    <div className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
            <FlaskConical size={15} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">
                Braintrust MCP
              </div>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${
                  configured
                    ? "border-success-border bg-success-bg text-success"
                    : "border-warning-border bg-warning-bg text-warning"
                }`}
              >
                {configured ? "Configured" : "Not connected"}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-5 text-ink-muted">
              Agents can opt in with @braintrust after Braintrust is connected.
            </p>
            {braintrust.statusReason ? (
              <p className="mt-1 text-[11.5px] leading-4 text-ink-subtle">
                {braintrust.statusReason}
              </p>
            ) : null}
          </div>
        </div>
        {configured ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              setMessage(null);
              setDismissedSetupStatus(setupStatus);
              startTransition(async () => {
                const result = await removeBraintrustMcpConnection();
                if (result.ok) {
                  setMessage({ type: "success", text: "Braintrust MCP connection removed." });
                  router.refresh();
                }
              });
            }}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={13} strokeWidth={1.9} />
            Remove
          </button>
        ) : null}
      </div>
      <div className="mt-4 border-t border-border-subtle pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={BRAINTRUST_MCP_START_URL}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85"
          >
            <ExternalLink size={13} strokeWidth={1.9} />
            {configured ? "Reconnect Braintrust" : "Connect Braintrust"}
          </a>
          <a
            href={BRAINTRUST_MCP_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-muted hover:text-ink"
          >
            MCP docs
            <ExternalLink size={12} strokeWidth={1.9} />
          </a>
        </div>
      </div>
      {visibleMessage && (
        <div
          className={`mt-2 text-[12px] ${
            visibleMessage.type === "success" ? "text-success" : "text-danger"
          }`}
        >
          {visibleMessage.text}
        </div>
      )}
      {configured ? (
        <ToolPolicyEditor providerKey="braintrust" overrides={policyOverrides} />
      ) : null}
    </div>
  );
}

function braintrustMcpSetupErrorMessage(reason: string | null) {
  switch (reason) {
    case "invalid_state":
      return "Braintrust connection expired or was started in another browser tab. Try reconnecting Braintrust.";
    case "session_mismatch":
      return "Braintrust returned to a different OpenCompany session. Sign in to the same workspace and try again.";
    case "braintrust_denied":
      return "Braintrust did not authorize the connection.";
    case "missing_code":
      return "Braintrust did not return an authorization code. Try reconnecting Braintrust.";
    case "token_exchange_failed":
      return "Braintrust authorized the connection, but token exchange failed. Check the server logs and try again.";
    case "start_failed":
      return "Could not start Braintrust authorization. Check the server logs and try again.";
    default:
      return "Braintrust connection failed. Try reconnecting Braintrust.";
  }
}

function NotionMcpCard({
  notion,
  setupStatus,
  setupReason,
  policyOverrides,
}: {
  notion: Props["mcp"]["notion"];
  setupStatus: "connected" | "error" | null;
  setupReason: string | null;
  policyOverrides: WorkspaceToolPolicyOverrides[string] | undefined;
}) {
  const router = useRouter();
  const [dismissedSetupStatus, setDismissedSetupStatus] = useState<"connected" | "error" | null>(
    null,
  );
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const configured = notion.configured;
  const setupMessage =
    setupStatus && setupStatus !== dismissedSetupStatus
      ? {
          type: setupStatus === "connected" ? ("success" as const) : ("error" as const),
          text:
            setupStatus === "connected"
              ? "Notion connected."
              : notionMcpSetupErrorMessage(setupReason),
        }
      : null;
  const visibleMessage = message ?? setupMessage;

  return (
    <div className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
            <FileText size={15} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">Notion MCP</div>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${
                  configured
                    ? "border-success-border bg-success-bg text-success"
                    : "border-warning-border bg-warning-bg text-warning"
                }`}
              >
                {configured ? "Configured" : "Not connected"}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-5 text-ink-muted">
              Agents can opt in with @notion after Notion is connected.
            </p>
            {notion.statusReason ? (
              <p className="mt-1 text-[11.5px] leading-4 text-ink-subtle">{notion.statusReason}</p>
            ) : null}
          </div>
        </div>
        {configured ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              setMessage(null);
              setDismissedSetupStatus(setupStatus);
              startTransition(async () => {
                const result = await removeNotionMcpConnection();
                if (result.ok) {
                  setMessage({ type: "success", text: "Notion MCP connection removed." });
                  router.refresh();
                }
              });
            }}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={13} strokeWidth={1.9} />
            Remove
          </button>
        ) : null}
      </div>
      <div className="mt-4 border-t border-border-subtle pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={NOTION_MCP_START_URL}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85"
          >
            <ExternalLink size={13} strokeWidth={1.9} />
            {configured ? "Reconnect Notion" : "Connect Notion"}
          </a>
          <a
            href={NOTION_MCP_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-muted hover:text-ink"
          >
            MCP docs
            <ExternalLink size={12} strokeWidth={1.9} />
          </a>
        </div>
      </div>
      {visibleMessage && (
        <div
          className={`mt-2 text-[12px] ${
            visibleMessage.type === "success" ? "text-success" : "text-danger"
          }`}
        >
          {visibleMessage.text}
        </div>
      )}
      {configured ? <ToolPolicyEditor providerKey="notion" overrides={policyOverrides} /> : null}
    </div>
  );
}

function notionMcpSetupErrorMessage(reason: string | null) {
  switch (reason) {
    case "invalid_state":
      return "Notion connection expired or was started in another browser tab. Try reconnecting Notion.";
    case "session_mismatch":
      return "Notion returned to a different OpenCompany session. Sign in to the same workspace and try again.";
    case "notion_denied":
      return "Notion did not authorize the connection.";
    case "missing_code":
      return "Notion did not return an authorization code. Try reconnecting Notion.";
    case "token_exchange_failed":
      return "Notion authorized the connection, but token exchange failed. Check the server logs and try again.";
    case "start_failed":
      return "Could not start Notion authorization. Check the server logs and try again.";
    default:
      return "Notion connection failed. Try reconnecting Notion.";
  }
}

function ProfileAvatar({ avatarUrl, initials }: { avatarUrl: string | null; initials: string }) {
  if (avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt=""
        className="h-12 w-12 rounded-full object-cover ring-1 ring-black/[0.06]"
      />
    );
  }
  return (
    <div
      aria-hidden
      className="flex h-12 w-12 items-center justify-center rounded-full text-[14px] font-semibold text-canvas ring-1 ring-black/[0.06]"
      style={{
        background: "radial-gradient(circle at 30% 30%, #c9d9ff 0%, #3b5bdb 35%, #0b1224 80%)",
      }}
    >
      {initials}
    </div>
  );
}

// Resize any picked image to a centered 256px square and encode as webp on the client,
// so we never ship a multi-MB original to the server or store one in Postgres.
async function resizeImageToSquareWebp(
  file: File,
): Promise<{ dataBase64: string; previewUrl: string }> {
  const SIZE = 256;
  const bitmap = await createImageBitmap(file);
  if (!bitmap.width || !bitmap.height) {
    bitmap.close?.();
    throw new Error("Invalid image dimensions.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available.");
  const scale = Math.max(SIZE / bitmap.width, SIZE / bitmap.height);
  const drawW = bitmap.width * scale;
  const drawH = bitmap.height * scale;
  ctx.drawImage(bitmap, (SIZE - drawW) / 2, (SIZE - drawH) / 2, drawW, drawH);
  bitmap.close?.();
  // The server derives the real mime from magic bytes, so we just hand over the bytes.
  // (Browsers without webp encode fall back to png, which the server also accepts.)
  const dataUrl = canvas.toDataURL("image/webp", 0.9);
  const dataBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { dataBase64, previewUrl: dataUrl };
}

function AvatarForm({
  avatarUrl,
  initials,
  hasCustomAvatar,
}: {
  avatarUrl: string | null;
  initials: string;
  hasCustomAvatar: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const hasPhoto = (hasCustomAvatar && !removed) || Boolean(preview);
  const shownUrl = removed ? null : (preview ?? avatarUrl);

  const onPick = async (file: File) => {
    setError(null);
    let resized: { dataBase64: string; previewUrl: string };
    try {
      resized = await resizeImageToSquareWebp(file);
    } catch {
      setError("Could not process that image.");
      return;
    }
    setPreview(resized.previewUrl);
    setRemoved(false);
    startTransition(async () => {
      const res = await updateAvatar({ dataBase64: resized.dataBase64 });
      if (res.ok) {
        router.refresh();
      } else {
        setError(res.error);
        setPreview(null);
      }
    });
  };

  const onRemove = () => {
    setError(null);
    startTransition(async () => {
      const res = await removeAvatar();
      if (res.ok) {
        setPreview(null);
        setRemoved(true);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  };

  return (
    <div className="flex items-center gap-4">
      <ProfileAvatar avatarUrl={shownUrl} initials={initials} />
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onPick(file);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={isPending}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? "Saving…" : hasPhoto ? "Change photo" : "Upload photo"}
          </button>
          {hasPhoto && !isPending && (
            <button
              type="button"
              onClick={onRemove}
              className="inline-flex h-8 items-center rounded-md px-2.5 text-[12.5px] font-medium text-ink-muted transition-colors duration-150 hover:text-ink"
            >
              Remove
            </button>
          )}
        </div>
        {error ? (
          <span className="text-[12px] text-danger">{error}</span>
        ) : (
          <span className="text-[11.5px] text-ink-subtle">
            PNG, JPEG or WebP. Square images look best.
          </span>
        )}
      </div>
    </div>
  );
}

function WorkspaceNameForm({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const dirty = value.trim() !== initial && value.trim().length > 0;

  const submit = (next: string) => {
    setError(null);
    startTransition(async () => {
      const res = await updateWorkspaceName(next);
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 1800);
      } else {
        setError(res.error);
      }
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!dirty || isPending) return;
        submit(value);
      }}
      className="flex items-center gap-2"
    >
      <input
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
        }}
        maxLength={80}
        className="h-8 flex-1 rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none transition-colors focus:border-ink/30 focus:ring-1 focus:ring-ink/15"
      />
      <button
        type="submit"
        disabled={!dirty || isPending}
        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? "Saving…" : "Save"}
      </button>
      {saved && (
        <span className="inline-flex items-center gap-1 text-[12px] text-success">
          <Check size={13} strokeWidth={2} />
          Saved
        </span>
      )}
      {error && <span className="text-[12px] text-danger">{error}</span>}
    </form>
  );
}

export default function SettingsView({ profile, workspace, billing, mcp, toolPolicies }: Props) {
  return (
    <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] px-8 pb-24 pt-10">
        <div>
          <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Settings</h1>
          <p className="mt-1 text-[13px] tracking-[-0.005em] text-ink-muted">
            Manage your profile and workspace.
          </p>
        </div>

        <div className="mt-8">
          <Section
            title="Profile"
            description="Shown on your profile. Email is managed by your identity provider."
          >
            {/* key resets the optimistic preview/removed state once the server
                refresh delivers a new avatarUrl (e.g. the IdP avatar after a remove). */}
            <AvatarForm
              key={profile.avatarUrl ?? "none"}
              avatarUrl={profile.avatarUrl}
              initials={profile.initials}
              hasCustomAvatar={profile.hasCustomAvatar}
            />
            <div className="min-w-0">
              <div className="truncate text-[14px] font-medium text-ink">{profile.name}</div>
              <div className="truncate text-[12.5px] text-ink-muted">{profile.email}</div>
            </div>
            <Field label="Email">
              <ReadOnly value={profile.email} />
            </Field>
          </Section>

          <Section title="Appearance" description="Choose the color mode for this device.">
            <Field label="Theme">
              <AppearanceSection />
            </Field>
          </Section>

          <Section title="Workspace" description="Visible to everyone in this workspace.">
            <Field label="Workspace name">
              <WorkspaceNameForm initial={workspace.name} />
            </Field>
            <Field label="Created">
              <ReadOnly value={workspace.createdAt} />
            </Field>
          </Section>

          <Section
            title="Workspace state"
            description="How this workspace is stored and versioned."
          >
            <WorkspaceState sync={workspace.sync} />
          </Section>

          <Section
            title="Integrations"
            description="Connect workspace resources agents can access."
          >
            <Link
              href="/company/settings/integrations"
              className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted"
            >
              <Plug size={13} strokeWidth={1.9} />
              Open integrations
            </Link>
          </Section>

          <Section title="Billing" description="Workspace credits are stored in USD cents.">
            <BillingPanel billing={billing} sessionPathPrefix="/company" />
          </Section>

          <Section title="Account" description="Sign out of all sessions for this device.">
            <a
              href="/auth/sign-out"
              className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted"
            >
              <LogOut size={13} strokeWidth={1.9} />
              Log out
            </a>
          </Section>

          <Section
            title="MCP servers"
            description="Connect workspace MCP servers that agents can use."
          >
            <McpServersSection mcp={mcp} toolPolicies={toolPolicies} />
          </Section>
        </div>
      </div>
    </main>
  );
}
