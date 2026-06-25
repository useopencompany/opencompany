"use client";

import {
  BarChart3,
  ExternalLink,
  FileText,
  FlaskConical,
  KeyRound,
  type LucideIcon,
  MessageSquare,
  Monitor,
  Trash2,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
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
import type {
  McpProviderKey,
  WorkspaceMcpProviderSettings,
  WorkspaceMcpSettings,
} from "@/lib/mcp/data";
import type { WorkspaceToolPolicyOverrides } from "@/lib/tool-policies/data";

const MCP_RETURN_TO = "/company/integrations";
const LINEAR_API_KEYS_URL = "https://linear.app/settings/account/security";

type SetupStatus = "connected" | "error";
type FeedbackMessage = { type: "success" | "error"; text: string };
type SearchParamsReader = { get(name: string): string | null };

type McpProviderConfig = {
  key: McpProviderKey;
  name: string;
  icon: LucideIcon;
  docsUrl: string;
  remove: () => Promise<{ ok: true }>;
  removeSuccessMessage: string;
  startFailureMessage?: string;
};

const MCP_PROVIDERS: McpProviderConfig[] = [
  {
    key: "linear",
    name: "Linear",
    icon: KeyRound,
    docsUrl: "https://linear.app/docs/mcp",
    remove: removeLinearMcpToken,
    removeSuccessMessage: "Linear MCP token removed.",
  },
  {
    key: "slack",
    name: "Slack",
    icon: MessageSquare,
    docsUrl: "https://docs.slack.dev/ai/slack-mcp-server/",
    remove: removeSlackMcpConnection,
    removeSuccessMessage: "Slack MCP connection removed.",
    startFailureMessage:
      "Could not start Slack authorization. Check SLACK_MCP_CLIENT_ID and SLACK_MCP_CLIENT_SECRET, then try again.",
  },
  {
    key: "posthog",
    name: "PostHog",
    icon: BarChart3,
    docsUrl: "https://posthog.com/docs/model-context-protocol",
    remove: removePostHogMcpConnection,
    removeSuccessMessage: "PostHog MCP connection removed.",
  },
  {
    key: "betterstack",
    name: "Better Stack",
    icon: Monitor,
    docsUrl: "https://betterstack.com/docs/getting-started/integrations/mcp/",
    remove: removeBetterStackMcpConnection,
    removeSuccessMessage: "Better Stack MCP connection removed.",
  },
  {
    key: "braintrust",
    name: "Braintrust",
    icon: FlaskConical,
    docsUrl: "https://www.braintrust.dev/docs/integrations/developer-tools/mcp",
    remove: removeBraintrustMcpConnection,
    removeSuccessMessage: "Braintrust MCP connection removed.",
  },
  {
    key: "notion",
    name: "Notion",
    icon: FileText,
    docsUrl: "https://developers.notion.com/guides/mcp/overview",
    remove: removeNotionMcpConnection,
    removeSuccessMessage: "Notion MCP connection removed.",
  },
];

export function WorkspaceMcpIntegrations({
  mcp,
  toolPolicies,
}: {
  mcp: WorkspaceMcpSettings;
  toolPolicies: WorkspaceToolPolicyOverrides;
}) {
  const searchParams = useSearchParams();

  return (
    <div className="mt-3 space-y-3">
      {MCP_PROVIDERS.map((provider) => (
        <McpIntegrationCard
          key={provider.key}
          provider={provider}
          settings={mcp[provider.key]}
          setupStatus={setupStatus(searchParams, provider.key)}
          setupReason={setupReason(searchParams, provider.key)}
          policyOverrides={toolPolicies[provider.key]}
        />
      ))}
    </div>
  );
}

function McpIntegrationCard({
  provider,
  settings,
  setupStatus,
  setupReason,
  policyOverrides,
}: {
  provider: McpProviderConfig;
  settings: WorkspaceMcpProviderSettings;
  setupStatus: SetupStatus | null;
  setupReason: string | null;
  policyOverrides: WorkspaceToolPolicyOverrides[string] | undefined;
}) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [dismissedSetupStatus, setDismissedSetupStatus] = useState<SetupStatus | null>(null);
  const [message, setMessage] = useState<FeedbackMessage | null>(null);
  const [isPending, startTransition] = useTransition();
  const configured = settings.configured;
  const Icon = provider.icon;
  const setupMessage =
    setupStatus && setupStatus !== dismissedSetupStatus
      ? {
          type: setupStatus === "connected" ? ("success" as const) : ("error" as const),
          text:
            setupStatus === "connected"
              ? `${provider.name} connected.`
              : mcpSetupErrorMessage(provider, setupReason),
        }
      : null;
  const visibleMessage = message ?? setupMessage;

  const card = (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
            <Icon size={15} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">
                {provider.name} MCP
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
              Agents can opt in with @{provider.key} after {provider.name} is connected.
            </p>
            {settings.statusReason ? (
              <p className="mt-1 text-[11.5px] leading-4 text-ink-subtle">
                {settings.statusReason}
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
                const result = await provider.remove();
                if (result.ok) {
                  setMessage({ type: "success", text: provider.removeSuccessMessage });
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
            href={mcpStartUrl(provider.key)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85"
          >
            <ExternalLink size={13} strokeWidth={1.9} />
            {configured ? `Reconnect ${provider.name}` : `Connect ${provider.name}`}
          </a>
          <a
            href={provider.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-muted hover:text-ink"
          >
            MCP docs
            <ExternalLink size={12} strokeWidth={1.9} />
          </a>
        </div>
        {provider.key === "linear" ? (
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
        ) : null}
      </div>

      {visibleMessage ? (
        <div
          className={`mt-2 text-[12px] ${
            visibleMessage.type === "success" ? "text-success" : "text-danger"
          }`}
        >
          {visibleMessage.text}
        </div>
      ) : null}

      {configured ? (
        <ToolPolicyEditor providerKey={provider.key} overrides={policyOverrides} />
      ) : null}
    </>
  );

  if (provider.key !== "linear") {
    return (
      <div className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
        {card}
      </div>
    );
  }

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
      {card}
    </form>
  );
}

function setupStatus(
  searchParams: SearchParamsReader,
  provider: McpProviderKey,
): SetupStatus | null {
  if (searchParams.get("mcp") !== provider) return null;
  const status = searchParams.get("setup");
  return status === "connected" || status === "error" ? status : null;
}

function setupReason(searchParams: SearchParamsReader, provider: McpProviderKey) {
  return searchParams.get("mcp") === provider ? searchParams.get("reason") : null;
}

function mcpStartUrl(provider: McpProviderKey) {
  return `/api/mcp/${provider}/start?returnTo=${MCP_RETURN_TO}`;
}

function mcpSetupErrorMessage(provider: McpProviderConfig, reason: string | null) {
  switch (reason) {
    case "invalid_state":
      return `${provider.name} connection expired or was started in another browser tab. Try reconnecting ${provider.name}.`;
    case "session_mismatch":
      return `${provider.name} returned to a different OpenCompany session. Sign in to the same workspace and try again.`;
    case `${provider.key}_denied`:
      return `${provider.name} did not authorize the connection.`;
    case "missing_code":
      return `${provider.name} did not return an authorization code. Try reconnecting ${provider.name}.`;
    case "token_exchange_failed":
      return `${provider.name} authorized the connection, but token exchange failed. Check the server logs and try again.`;
    case "start_failed":
      return (
        provider.startFailureMessage ??
        `Could not start ${provider.name} authorization. Check the server logs and try again.`
      );
    default:
      return `${provider.name} connection failed. Try reconnecting ${provider.name}.`;
  }
}
