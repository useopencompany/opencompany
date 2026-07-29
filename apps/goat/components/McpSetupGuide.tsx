"use client";

import type { GoatMcpClient } from "@opencompany/db/goat-schema";
import { toast } from "@opencompany/ui/components/sonner";
import { AnthropicIcon, type LucideIcon as IconComponent, OpenAIIcon } from "@opencompany/ui/icons";
import { Check, CheckCircle2, Code2, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useHydrated } from "@/components/useHydrated";
import {
  buildCursorMcpConfig,
  buildCursorMcpDeeplink,
  buildGoatMcpFirstPrompt,
  GOAT_USER_MCP_ENDPOINT_PATH,
  OPENCOMPANY_MCP_SERVER_NAME,
} from "@/lib/mcp-setup";
import {
  checkGoatMcpSetupStatusAction,
  savePreferredGoatMcpClientAction,
} from "@/lib/mcp-setup-actions";

type ClientDefinition = {
  id: GoatMcpClient;
  label: string;
  description: string;
  docsUrl: string;
  icon: IconComponent;
  steps: string[];
  note?: string;
};

const CLIENTS: ClientDefinition[] = [
  {
    id: "claude",
    label: "Claude",
    description: "Claude, Claude Desktop, and Cowork",
    docsUrl:
      "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
    icon: AnthropicIcon,
    steps: [
      "Open Customize → Connectors.",
      "Choose + → Add custom connector and paste the connector URL below.",
      "Add the connector, click Connect, and sign in with your OpenCompany account.",
      "In a new chat, use + → Connectors to enable OpenCompany.",
    ],
    note: "On Claude Team and Enterprise, an owner must add the connector to the organization before members can connect it.",
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    description: "ChatGPT apps on the web",
    docsUrl: "https://help.openai.com/en/articles/12584461",
    icon: OpenAIIcon,
    steps: [
      "Open Settings → Apps → Advanced Settings and enable Developer mode if it is available.",
      "Choose Apps → Create and paste the connector URL below as the MCP endpoint.",
      "Select OAuth, scan the tools, and complete the OpenCompany sign-in prompt.",
      "Create the app, then select it from the tools menu in a new chat.",
    ],
    note: "Custom MCP app availability depends on your ChatGPT plan and workspace permissions. If Create is unavailable, ask a ChatGPT workspace admin to publish the app first.",
  },
  {
    id: "cursor",
    label: "Cursor",
    description: "Cursor Agent and Composer",
    docsUrl: "https://docs.cursor.com/context/model-context-protocol",
    icon: Code2,
    steps: [
      "Use Add to Cursor below and approve the server configuration.",
      "Open Cursor Settings → MCP and connect the new OpenCompany server.",
      "Complete the OpenCompany sign-in prompt in your browser.",
      "Open Agent and make sure the OpenCompany tools are enabled.",
    ],
  },
];

type CopiedValue = "url" | "config" | "prompt" | null;

export function McpSetupGuide({
  displayName,
  workspaceName,
  initialClient,
  initialCompletedAt,
  hideHeader = false,
}: {
  displayName: string;
  workspaceName: string;
  initialClient: GoatMcpClient | null;
  initialCompletedAt: string | null;
  hideHeader?: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [client, setClient] = useState<GoatMcpClient | null>(initialClient);
  const [copied, setCopied] = useState<CopiedValue>(null);
  const [waiting, setWaiting] = useState(false);
  const [completedAt, setCompletedAt] = useState(initialCompletedAt);
  const [pollError, setPollError] = useState(false);
  const [isSavingClient, startSavingClient] = useTransition();

  const selectedClient = CLIENTS.find((definition) => definition.id === client) ?? null;
  const origin = hydrated ? window.location.origin.replace(/\/+$/, "") : "";
  const connectorUrl = origin
    ? `${origin}${GOAT_USER_MCP_ENDPOINT_PATH}`
    : GOAT_USER_MCP_ENDPOINT_PATH;
  const cursorConfig = useMemo(
    () =>
      JSON.stringify(
        buildCursorMcpConfig({ name: OPENCOMPANY_MCP_SERVER_NAME, url: connectorUrl }),
        null,
        2,
      ),
    [connectorUrl],
  );
  const cursorDeeplink = hydrated
    ? buildCursorMcpDeeplink({ name: OPENCOMPANY_MCP_SERVER_NAME, url: connectorUrl })
    : "";
  const firstPrompt = buildGoatMcpFirstPrompt({ displayName, workspaceName });

  useEffect(() => {
    if (!waiting || completedAt) return;

    let active = true;
    let pollInFlight = false;
    const poll = async () => {
      if (pollInFlight || document.visibilityState === "hidden") return;
      pollInFlight = true;
      try {
        const status = await checkGoatMcpSetupStatusAction();
        if (!active) return;
        setPollError(false);
        if (status.complete) {
          setCompletedAt(status.completedAt ?? new Date().toISOString());
          setWaiting(false);
          router.refresh();
        }
      } catch {
        if (active) setPollError(true);
      } finally {
        pollInFlight = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [completedAt, router, waiting]);

  const chooseClient = (nextClient: GoatMcpClient) => {
    const previousClient = client;
    setClient(nextClient);
    startSavingClient(async () => {
      const result = await savePreferredGoatMcpClientAction(nextClient);
      if (!result.ok) {
        setClient(previousClient);
        toast.error(result.error);
      }
    });
  };

  const copyValue = async (value: string, kind: Exclude<CopiedValue, null>) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      if (kind === "prompt" && !completedAt) {
        setWaiting(true);
        setPollError(false);
      }
      window.setTimeout(() => setCopied((current) => (current === kind ? null : current)), 1200);
    } catch {
      toast.error("Could not copy to your clipboard.");
    }
  };

  return (
    <div>
      {hideHeader ? null : <GuideHeader />}

      <section aria-labelledby="mcp-client-heading">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 id="mcp-client-heading" className="text-[12px] font-medium text-ink">
            1. Choose where you work
          </h2>
          {isSavingClient ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-ink-subtle">
              <Loader2 size={11} className="animate-spin" /> Saving
            </span>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {CLIENTS.map((definition) => {
            const Icon = definition.icon;
            const selected = definition.id === client;
            return (
              <button
                key={definition.id}
                type="button"
                aria-pressed={selected}
                onClick={() => chooseClient(definition.id)}
                disabled={isSavingClient}
                className={`flex min-h-24 flex-col items-start rounded-xl border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/15 ${
                  selected
                    ? "border-ink/35 bg-surface-active"
                    : "border-border bg-surface hover:bg-surface-hover"
                } disabled:cursor-wait disabled:opacity-70`}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <Icon size={17} strokeWidth={1.9} className="text-ink" />
                  {selected ? <CheckCircle2 size={15} className="text-ink" /> : null}
                </span>
                <span className="mt-3 text-[13px] font-semibold text-ink">{definition.label}</span>
                <span className="mt-0.5 text-[11.5px] leading-4 text-ink-subtle">
                  {definition.description}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {selectedClient ? (
        <>
          <section className="mt-6" aria-labelledby="mcp-connect-heading">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 id="mcp-connect-heading" className="text-[12px] font-medium text-ink">
                2. Connect OpenCompany
              </h2>
              <a
                href={selectedClient.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11.5px] text-ink-subtle transition-colors hover:text-ink"
              >
                Official guide <ExternalLink size={11} />
              </a>
            </div>

            <div className="rounded-xl border border-border bg-surface p-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-ink">Connector URL</span>
                <CopyRow
                  value={connectorUrl}
                  copied={copied === "url"}
                  label="Copy connector URL"
                  canCopy={Boolean(origin)}
                  onCopy={() => void copyValue(connectorUrl, "url")}
                />
              </div>

              {client === "cursor" ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <a
                    href={cursorDeeplink || undefined}
                    aria-disabled={!cursorDeeplink}
                    className={`inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink px-3 text-[12.5px] font-semibold text-canvas transition-opacity hover:opacity-90 ${
                      cursorDeeplink ? "" : "pointer-events-none opacity-40"
                    }`}
                  >
                    <Code2 size={14} /> Add to Cursor
                  </a>
                  <button
                    type="button"
                    onClick={() => void copyValue(cursorConfig, "config")}
                    disabled={!origin}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-[12.5px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {copied === "config" ? <Check size={14} /> : <Copy size={14} />}
                    Copy mcp.json
                  </button>
                </div>
              ) : null}
            </div>

            <ol className="mt-4 flex flex-col gap-2.5">
              {selectedClient.steps.map((step, index) => (
                <li key={step} className="flex items-start gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-active text-[10.5px] font-semibold text-ink">
                    {index + 1}
                  </span>
                  <span className="text-[12.5px] leading-5 text-ink-muted">{step}</span>
                </li>
              ))}
            </ol>
            {selectedClient.note ? (
              <p className="mt-3 rounded-lg bg-surface-muted px-3 py-2 text-[11.5px] leading-5 text-ink-subtle">
                {selectedClient.note}
              </p>
            ) : null}
          </section>

          <section className="mt-6" aria-labelledby="mcp-query-heading">
            <h2 id="mcp-query-heading" className="mb-2 text-[12px] font-medium text-ink">
              3. Ask your first useful question
            </h2>
            <div className="rounded-xl border border-border bg-surface p-4">
              <p className="text-[12px] leading-5 text-ink-subtle">
                Paste this into {selectedClient.label}. It starts with a Brain search so OpenCompany
                can verify the connection.
              </p>
              <div className="mt-3 rounded-lg bg-surface-muted p-3">
                <p className="text-[12.5px] leading-5 text-ink-muted">{firstPrompt}</p>
              </div>
              <button
                type="button"
                onClick={() => void copyValue(firstPrompt, "prompt")}
                className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink px-3 text-[12.5px] font-semibold text-canvas transition-opacity hover:opacity-90"
              >
                {copied === "prompt" ? <Check size={14} /> : <Copy size={14} />}
                {copied === "prompt" ? "Copied" : "Copy first question"}
              </button>
            </div>

            <SetupStatus completedAt={completedAt} waiting={waiting} pollError={pollError} />
          </section>
        </>
      ) : (
        <p className="mt-5 text-[12.5px] leading-5 text-ink-subtle">
          Choose the AI client you use most to see its setup steps.
        </p>
      )}
    </div>
  );
}

function GuideHeader() {
  return (
    <div className="mb-7 flex flex-col gap-2">
      <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">
        Use your brain where you already work
      </h1>
      <p className="text-[14px] leading-6 text-ink-muted">
        Connect one AI client, then ask a real question so OpenCompany can verify everything works.
      </p>
    </div>
  );
}

function CopyRow({
  value,
  copied,
  label,
  canCopy = true,
  onCopy,
}: {
  value: string;
  copied: boolean;
  label: string;
  canCopy?: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-muted px-3 py-2 text-[12px] text-ink-muted">
        {value}
      </code>
      <button
        type="button"
        onClick={onCopy}
        disabled={!value || !canCopy}
        aria-label={label}
        title={label}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-40"
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
    </div>
  );
}

function SetupStatus({
  completedAt,
  waiting,
  pollError,
}: {
  completedAt: string | null;
  waiting: boolean;
  pollError: boolean;
}) {
  if (completedAt) {
    return (
      <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-success-border bg-success-bg px-4 py-3">
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" />
        <div>
          <p className="text-[12.5px] font-semibold text-ink">OpenCompany is connected</p>
          <p className="mt-0.5 text-[11.5px] leading-4 text-ink-subtle">
            Your first MCP query reached OpenCompany successfully.
          </p>
        </div>
      </div>
    );
  }
  if (!waiting) return null;

  return (
    <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-border bg-surface px-4 py-3">
      <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin text-ink-subtle" />
      <div>
        <p className="text-[12.5px] font-medium text-ink">Waiting for your first Brain query…</p>
        <p
          className={`mt-0.5 text-[11.5px] leading-4 ${pollError ? "text-warning" : "text-ink-subtle"}`}
        >
          {pollError
            ? "OpenCompany could not check yet. Keep this page open and it will retry."
            : "Leave this page open, paste the question into your AI client, and approve the tool call."}
        </p>
      </div>
    </div>
  );
}
