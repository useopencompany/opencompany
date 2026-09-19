"use client";

import type { CompanyAgentSlackDto } from "@opencompany/protocol";
import { Button } from "@opencompany/ui/components/button";
import { Input } from "@opencompany/ui/components/input";
import { useCallback, useEffect, useState } from "react";
import {
  connectCompanyAgentSlack,
  disconnectCompanyAgentSlack,
  getCompanyAgentSlack,
} from "@/lib/company-agent-commands";

export function CompanyAgentSlack({
  agentId,
  canEdit,
  enabled,
}: {
  agentId: string;
  canEdit: boolean;
  enabled: boolean;
}) {
  const [connection, setConnection] = useState<CompanyAgentSlackDto | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [copied, setCopied] = useState(false);
  const refresh = useCallback(async () => {
    setError("");
    try {
      setConnection(await getCompanyAgentSlack(agentId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Slack setup.");
    }
  }, [agentId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function connect() {
    setBusy(true);
    setError("");
    try {
      setConnection(await connectCompanyAgentSlack(agentId, { botToken, signingSecret }));
      setBotToken("");
      setSigningSecret("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect Slack.");
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      await disconnectCompanyAgentSlack(agentId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disconnect Slack.");
    } finally {
      setBusy(false);
    }
  }
  async function copyManifest() {
    if (!connection) return;
    try {
      await navigator.clipboard.writeText(connection.manifest);
      setCopied(true);
    } catch {
      setError("Copying failed. Select and copy the configuration below.");
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-3.5 text-[13px]">
      <div>
        <p className="font-medium text-ink">This agent in Slack</p>
        <p className="mt-1 text-ink-subtle">
          Give this agent its own profile so teammates can mention it and send it direct messages.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      {!connection && (
        <Button variant="outline" size="sm" onClick={refresh}>
          {error ? "Retry" : "Loading Slack setup…"}
        </Button>
      )}
      {connection && (
        <>
          <p role="status" className="text-ink-subtle">
            {connection.ready
              ? `Connected to ${connection.teamName ?? "Slack"}.${enabled ? " Invite the agent to a public channel and mention it to start work." : " Turn on Slack above to let it respond."}`
              : connection.installed
                ? (connection.statusReason ?? "Finish setup in Slack.")
                : "Beta setup requires a separate Slack app for each agent."}
          </p>
          {connection.ready && connection.openUrl && (
            <a className="text-ink underline" href={connection.openUrl}>
              Open in Slack
            </a>
          )}
          {canEdit && (
            <details open={connection.installed && !connection.ready}>
              <summary className="cursor-pointer font-medium text-ink">
                {connection.installed ? "Connection settings" : "Set up in Slack"}
              </summary>
              <div className="mt-3 flex flex-col gap-4">
                <p className="text-ink-subtle">
                  Your Slack workspace may require an admin to approve the app. Members need an
                  opencompany account with their Slack email. The agent uses its owner's connected
                  tools.
                </p>
                {!connection.installed && (
                  <div>
                    <p className="mb-1 font-medium">1. Create and install the app</p>
                    <a
                      href={connection.appUrl ?? connection.createUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      {connection.appUrl
                        ? "Open this agent's existing Slack app"
                        : "Create Slack app with this agent's configuration"}
                    </a>
                    <p className="mt-1 text-ink-subtle">
                      {connection.appUrl
                        ? "Reconnect the original app: select Install to Workspace under OAuth & Permissions."
                        : "Choose your workspace, create the app, then select Install to Workspace under OAuth & Permissions."}
                    </p>
                  </div>
                )}
                {(!connection.ready || connection.status !== "connected") && (
                  <div className="flex flex-col gap-2">
                    <p className="font-medium">2. Connect the installed bot</p>
                    <label htmlFor={`slack-token-${agentId}`}>
                      Bot User OAuth Token · OAuth &amp; Permissions
                    </label>
                    <Input
                      id={`slack-token-${agentId}`}
                      type="password"
                      autoComplete="off"
                      value={botToken}
                      onChange={(event) => setBotToken(event.target.value)}
                      placeholder="xoxb-…"
                    />
                    <label htmlFor={`slack-signing-${agentId}`}>
                      Signing Secret · Basic Information → App Credentials
                    </label>
                    <Input
                      id={`slack-signing-${agentId}`}
                      type="password"
                      autoComplete="off"
                      value={signingSecret}
                      onChange={(event) => setSigningSecret(event.target.value)}
                    />
                    <Button
                      size="sm"
                      disabled={busy || !botToken || !signingSecret}
                      onClick={connect}
                    >
                      {busy ? "Connecting…" : "Connect bot"}
                    </Button>
                  </div>
                )}
                {connection.installed && (
                  <div className="flex flex-col gap-2">
                    <p className="font-medium">3. Enable conversations</p>
                    <p className="text-ink-subtle">
                      Copy the configuration below into App Manifest in your{" "}
                      <a
                        href={connection.appUrl ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        Slack app settings
                      </a>{" "}
                      and save it. Slack will verify the connection. Set the app's icon in Basic
                      Information.
                    </p>
                    <Button variant="outline" size="sm" onClick={copyManifest}>
                      {copied ? "Copied" : "Copy Slack configuration"}
                    </Button>
                    <details>
                      <summary className="cursor-pointer text-ink-subtle">
                        View configuration
                      </summary>
                      <pre className="mt-2 max-h-60 overflow-auto rounded bg-canvas p-2 text-[11px]">
                        {connection.manifest}
                      </pre>
                    </details>
                    <Button variant="outline" size="sm" onClick={refresh}>
                      Check connection
                    </Button>
                    <p className="text-ink-subtle">
                      Names and photos on a dedicated Slack profile are managed in Slack during this
                      beta. Public channels and direct messages are supported.
                    </p>
                  </div>
                )}
                {connection.installed && (
                  <div>
                    <Button variant="outline" size="sm" disabled={busy} onClick={disconnect}>
                      Disconnect agent from Slack
                    </Button>
                    <p className="mt-1 text-ink-subtle">
                      Stops this agent's Slack conversations. You can remove the app itself in Slack
                      settings.
                    </p>
                  </div>
                )}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
