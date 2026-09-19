"use client";

import type { CompanyAgentSlackDto } from "@opencompany/protocol";
import { Button } from "@opencompany/ui/components/button";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { connectCompanyAgentSlack, getCompanyAgentSlack } from "@/lib/company-agent-commands";

export function CompanyAgentSlack({
  agentId,
  canEdit,
  enabled,
  active,
}: {
  agentId: string;
  canEdit: boolean;
  enabled: boolean;
  active: boolean;
}) {
  const [data, setData] = useState<CompanyAgentSlackDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await getCompanyAgentSlack(agentId);
        if (!disposed) {
          setData(next);
          setError(null);
        }
      } catch (e) {
        if (!disposed)
          setError(e instanceof Error ? e.message : "Slack status could not be loaded.");
      }
      if (!disposed) timer = setTimeout(refresh, 4000);
    }
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [agentId, enabled]);
  const provisioning = data?.provisioning;
  const needsReconnect = data?.installed && data.status !== "connected";
  const available =
    data?.ready ||
    (data?.installed && data.status === "connected" && provisioning?.state === "ready");
  const failed = provisioning?.state === "failed" || provisioning?.state === "uncertain";
  const pending =
    enabled &&
    provisioning?.configured &&
    !failed &&
    (!available || ["queued", "creating", "created", "installed"].includes(provisioning.state));
  return (
    <div className="mt-3 rounded-lg border border-border p-4 text-[13px] leading-5">
      {error ? (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      ) : null}
      {!data ? (
        <p className="text-ink-subtle">Loading Slack status…</p>
      ) : !enabled ? (
        <>
          <p className="font-medium">Slack is off</p>
          <p className="mt-1 text-ink-subtle">
            {data.installed
              ? "This agent keeps its Slack identity, but won't respond until you turn Slack back on."
              : "Turn on Slack to give this agent its own profile for mentions and direct messages."}
          </p>
        </>
      ) : failed || needsReconnect ? (
        <>
          <p className="font-medium">Slack needs attention</p>
          <p className="mt-1 text-ink-subtle">
            {provisioning?.reason ??
              data?.statusReason ??
              "This Slack app needs to be reconnected."}
          </p>
          {data.appUrl ? (
            <a
              href={data.appUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 block underline underline-offset-4"
            >
              View app in Slack
            </a>
          ) : null}
          {canEdit &&
          (provisioning?.state === "failed" ||
            (needsReconnect && provisioning?.state === "ready")) ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              disabled={retrying}
              onClick={async () => {
                setRetrying(true);
                try {
                  setData(await connectCompanyAgentSlack(agentId));
                  setError(null);
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Retry failed.");
                } finally {
                  setRetrying(false);
                }
              }}
            >
              {retrying ? "Retrying…" : "Retry setup"}
            </Button>
          ) : null}
        </>
      ) : available ? (
        <>
          <p className="font-medium">
            {data.ready ? `Available in ${data.teamName ?? "Slack"}` : "Ready to test in Slack"}
          </p>
          <p className="mt-1 text-ink-subtle">
            {active
              ? "Invite this agent to a channel and @mention it, or send it a direct message."
              : "This agent is paused. Activate it to respond to mentions and direct messages."}
          </p>
          {data.openUrl ? (
            <a href={data.openUrl} className="mt-2 inline-block underline underline-offset-4">
              Open in Slack
            </a>
          ) : null}
        </>
      ) : pending ? (
        <>
          <p className="flex items-center gap-2 font-medium">
            <Loader2 className="size-3.5 animate-spin" /> Setting up Slack identity…
          </p>
          <p className="mt-1 text-ink-subtle">
            This usually takes a moment. You can leave this page while setup finishes.
          </p>
        </>
      ) : (
        <>
          <p className="font-medium">Workspace setup needed</p>
          <p className="mt-1 text-ink-subtle">
            Ask a workspace admin to authorize Slack identities once. This agent will then connect
            automatically.
          </p>
          <Link
            href="/settings/workspace/slack"
            className="mt-2 inline-block underline underline-offset-4"
          >
            Slack settings
          </Link>
        </>
      )}
    </div>
  );
}
