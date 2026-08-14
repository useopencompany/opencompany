"use client";

import { MessageSquare } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { SettingsContent } from "@/components/SettingsChrome";
import { disconnectSlackBotAction } from "@/lib/slack-bot-actions";

export type SlackBotSettingsData = {
  isAdmin: boolean;
  configured: boolean;
  installed: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  // Installed before the current scope set: mentions keep working, but the
  // newer features (DMs, mention-free follow-ups, status reactions) need a
  // reconnect to grant the added scopes.
  needsScopeUpgrade: boolean;
  teamName: string | null;
  statusReason: string | null;
  destinationCount: number;
  setup: "connected" | "error" | null;
  setupReason: string | null;
};

const SETUP_ERROR_COPY: Record<string, string> = {
  admin_required: "Only workspace admins can connect the Slack bot.",
  not_configured: "The Slack bot isn't configured on this deployment yet.",
  invalid_state: "The connection attempt expired. Try again.",
  session_mismatch: "The connection was started from a different session. Try again.",
  slack_denied: "Slack denied the connection request.",
  missing_code: "Slack didn't complete the connection. Try again.",
  connection_sync_failed: "Connecting to Slack failed. Try again.",
};

export function SlackBotSettings({ data }: { data: SlackBotSettingsData }) {
  return (
    <SettingsContent
      title="Slack bot"
      description="Answer questions from your brains directly in Slack. Beta."
    >
      {data.setup === "error" ? (
        <Banner tone="error">
          {SETUP_ERROR_COPY[data.setupReason ?? ""] ?? "Connecting the Slack bot failed."}
        </Banner>
      ) : null}
      {data.setup === "connected" ? (
        <Banner tone="success">The Slack bot is connected.</Banner>
      ) : null}

      {!data.isAdmin ? (
        <p className="text-[13px] leading-5 text-ink-subtle">
          Only workspace admins can manage the Slack bot.
        </p>
      ) : !data.configured ? (
        <p className="text-[13px] leading-5 text-ink-subtle">
          The Slack bot isn&apos;t configured on this deployment. Set the Slack bot and
          credential-encryption environment variables to enable it.
        </p>
      ) : (
        <SlackBotPanel data={data} />
      )}
    </SettingsContent>
  );
}

function SlackBotPanel({ data }: { data: SlackBotSettingsData }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const connectHref = "/api/integrations/slack-bot/start?returnTo=/settings/workspace/slack";

  const disconnect = () => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await disconnectSlackBotAction();
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
      } catch {
        setError("Disconnecting the Slack bot failed. Try again.");
      }
    });
  };

  if (!data.installed) {
    return (
      <section className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-lg border border-ink/10 p-4">
          <MessageSquare size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-subtle" />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[14px] font-medium leading-tight text-ink">
              Add opencompany to your Slack workspace
            </span>
            <p className="text-[13px] leading-5 text-ink-subtle">
              Once installed, mention @opencompany in a channel to get answers from your brains —
              for example “@opencompany what did we learn from customers this week?”.
            </p>
          </div>
        </div>
        <a
          href={connectHref}
          className="w-fit rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          Connect Slack
        </a>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-5">
      <div className="flex items-center gap-3 rounded-lg border border-ink/10 p-4">
        <MessageSquare size={18} strokeWidth={1.75} className="shrink-0 text-ink-subtle" />
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="min-w-0">
            <span className="block truncate text-[14px] font-medium leading-tight text-ink">
              {data.teamName ?? "Slack workspace"}
            </span>
            {data.status !== "connected" && data.statusReason ? (
              <span className="block truncate text-[12px] leading-4 text-ink-subtle">
                {data.statusReason}
              </span>
            ) : null}
          </div>
          <span className="ml-auto shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle">
            {data.status === "connected" ? "Connected" : "Needs attention"}
          </span>
        </div>
      </div>

      {data.status !== "connected" ? (
        <a
          href={connectHref}
          className="w-fit rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          Reconnect Slack
        </a>
      ) : data.needsScopeUpgrade ? (
        <div className="flex flex-col gap-3">
          <Banner tone="success">
            Reconnect Slack to enable the newest bot features: answers in DMs, thread replies
            without re-mentioning, and live status reactions.
          </Banner>
          <a
            href={connectHref}
            className="w-fit rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            Reconnect Slack
          </a>
        </div>
      ) : null}
      {data.status === "connected" ? (
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-ink">Next steps</span>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-[13px] leading-5 text-ink-subtle">
            <li>Invite @opencompany to the Slack channels where you want answers.</li>
            <li>
              Enable the bot per brain under{" "}
              <Link href="/" prefetch className="text-ink underline underline-offset-2">
                Brain settings → Destinations
              </Link>{" "}
              and pick its channels.
            </li>
            <li>
              Mention @opencompany in one of those channels and ask a question — replies in the
              thread continue the conversation without another mention, and team members can DM the
              bot directly.
            </li>
          </ol>
          <p className="text-[12px] leading-4 text-ink-subtle">
            {data.destinationCount > 0
              ? `${data.destinationCount} brain${data.destinationCount === 1 ? "" : "s"} currently answer${data.destinationCount === 1 ? "s" : ""} in Slack.`
              : "No brains are connected to Slack channels yet."}
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={disconnect}
          disabled={pending}
          className="w-fit rounded-md border border-ink/15 px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-surface-hover disabled:opacity-50 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          {pending ? "Disconnecting…" : "Disconnect"}
        </button>
        {error ? (
          <p role="alert" className="text-[12px] leading-4 text-red-600">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function Banner({ tone, children }: { tone: "success" | "error"; children: React.ReactNode }) {
  return (
    <div
      className={`rounded-md border px-3 py-2 text-[13px] leading-5 ${
        tone === "error"
          ? "border-red-200 bg-red-50 text-red-700"
          : "border-ink/10 bg-surface-muted text-ink"
      }`}
    >
      {children}
    </div>
  );
}
