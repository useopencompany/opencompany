"use client";

import { MessageSquare } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { PageContent } from "@/components/PageContent";
import { disconnectSlackBotAction } from "@/lib/slack-bot-actions";

export type SlackBotSettingsData = {
  isAdmin: boolean;
  configured: boolean;
  installed: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  needsScopeUpgrade: boolean;
  canCustomizeIdentity: boolean;
  canReact: boolean;
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
    <PageContent
      title="Slack"
      description="Share workflow results in Slack and continue the same work in a thread."
    >
      <p className="mb-5 text-[13px] leading-5 text-ink-subtle">
        This workspace connection is separate from your personal Slack plugin.
      </p>
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
          Slack Channels aren&apos;t available on this workspace yet. Contact your workspace
          administrator for help.
        </p>
      ) : (
        <SlackBotPanel data={data} />
      )}
    </PageContent>
  );
}

// A reconnect can be outstanding for scopes with no visible effect of their own, so only name the
// capabilities this installation is actually missing rather than asserting both every time.
function missingCapabilityCopy(data: SlackBotSettingsData) {
  const missing = [
    ...(data.canCustomizeIdentity ? [] : ["posts keep the default @opencompany identity"]),
    ...(data.canReact ? [] : ["thread replies get no progress reaction"]),
  ];
  return missing.join(" and ");
}

function SlackBotPanel({ data }: { data: SlackBotSettingsData }) {
  const missingCapabilities = missingCapabilityCopy(data);
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
              Let workflows post as @opencompany. Anyone who can reply in a workflow thread can
              continue the same work, with its context and files, for 30 days.
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
            {data.needsScopeUpgrade
              ? "Missing scopes"
              : data.status === "connected"
                ? "Healthy"
                : data.status === "needs_reauth"
                  ? "Reconnect required"
                  : "Needs attention"}
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
            Reconnect Slack to grant the newest bot scopes.
            {missingCapabilities ? ` Until then, ${missingCapabilities}.` : null}
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
            <li>Invite @opencompany to a public Slack channel.</li>
            <li>
              Add an instruction to a workflow, such as “Post the investigation summary in #product
              with the opencompany Slack bot.” Each post opens a thread for follow-up questions.
            </li>
          </ol>
          <p className="text-[13px] leading-5 text-ink-subtle">
            Anyone who can reply in the Slack thread can continue the workflow for 30 days, using
            the workflow owner’s connected tools and saved context. Disconnecting closes existing
            threads.
          </p>
          <Link
            href="/workflows"
            prefetch
            className="text-[12px] text-ink underline underline-offset-2"
          >
            Open workflows
          </Link>
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
