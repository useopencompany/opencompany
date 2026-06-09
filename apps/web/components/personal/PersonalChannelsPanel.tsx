"use client";

import { ArrowDownLeft, ArrowUpRight, MessageCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { connectWhatsappChannel, disconnectWhatsappChannel } from "@/lib/personal/channel-actions";
import type { WhatsAppChannelState, WhatsAppPendingLink } from "@/lib/personal/channels";

export function PersonalChannelsPanel({ whatsapp }: { whatsapp: WhatsAppChannelState }) {
  return (
    <div className="mx-auto w-full max-w-[680px] px-6 py-10">
      <div className="min-w-0">
        <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">Channels</h1>
        <p className="mt-1 text-[13px] text-ink-muted">
          Reach your personal agent from messaging apps. Messages route into your personal sessions
          — replies come straight back to the chat.
        </p>
      </div>

      <div className="mt-6">
        <WhatsAppCard whatsapp={whatsapp} />
      </div>
    </div>
  );
}

function WhatsAppCard({ whatsapp }: { whatsapp: WhatsAppChannelState }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingLink, setPendingLink] = useState<WhatsAppPendingLink | null>(whatsapp.pendingLink);
  const [error, setError] = useState<string | null>(null);

  const connected = whatsapp.status === "connected";
  const linking = !connected && pendingLink !== null;

  const handleConnect = () => {
    setError(null);
    startTransition(async () => {
      const result = await connectWhatsappChannel();
      if (result.ok) {
        setPendingLink({
          deeplink: result.deeplink,
          qrSvg: result.qrSvg,
          expiresAt: result.expiresAt,
        });
      } else {
        setError(result.error);
      }
    });
  };

  const handleDisconnect = () => {
    setError(null);
    startTransition(async () => {
      await disconnectWhatsappChannel();
      setPendingLink(null);
      router.refresh();
    });
  };

  return (
    <div className="rounded-lg border border-border bg-surface/55">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-emerald-600">
          <MessageCircle size={17} strokeWidth={1.85} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium text-ink">WhatsApp</span>
            <StatusPill
              status={whatsapp.status}
              linking={linking}
              configured={whatsapp.configured}
            />
          </div>
          <div className="mt-0.5 truncate text-[12px] leading-4 text-ink-muted">
            {connected && whatsapp.externalId
              ? `Linked to ${formatNumber(whatsapp.externalId)}${
                  whatsapp.profileName ? ` · ${whatsapp.profileName}` : ""
                }`
              : "Chat with your personal agent over WhatsApp."}
          </div>
        </div>
        <CardAction
          configured={whatsapp.configured}
          connected={connected}
          linking={linking}
          isPending={isPending}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
        />
      </div>

      {!whatsapp.configured && (
        <Notice tone="muted">
          WhatsApp isn’t set up on this deployment yet. Once the platform number is configured,
          you’ll be able to connect here.
        </Notice>
      )}

      {error && <Notice tone="error">{error}</Notice>}

      {linking && pendingLink && <LinkInstructions pendingLink={pendingLink} />}

      {connected && <ConnectedDetails whatsapp={whatsapp} />}
    </div>
  );
}

function CardAction({
  configured,
  connected,
  linking,
  isPending,
  onConnect,
  onDisconnect,
}: {
  configured: boolean;
  connected: boolean;
  linking: boolean;
  isPending: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  if (connected || linking) {
    return (
      <button
        type="button"
        onClick={onDisconnect}
        disabled={isPending}
        className="shrink-0 rounded-md border border-border px-3 py-1.5 text-[12.5px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-50"
      >
        {linking ? "Cancel" : "Disconnect"}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onConnect}
      disabled={isPending || !configured}
      className="shrink-0 rounded-md bg-ink px-3 py-1.5 text-[12.5px] font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-40"
    >
      {isPending ? "Connecting…" : "Connect"}
    </button>
  );
}

function LinkInstructions({ pendingLink }: { pendingLink: WhatsAppPendingLink }) {
  return (
    <div className="border-t border-border px-4 py-4">
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
        {/* Our own server-generated SVG — safe to inline. */}
        <div
          className="h-[180px] w-[180px] shrink-0 rounded-md border border-border bg-white p-2 [&>svg]:h-full [&>svg]:w-full"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: locally-generated QR SVG, no user input.
          dangerouslySetInnerHTML={{ __html: pendingLink.qrSvg }}
        />
        <div className="min-w-0 flex-1 text-[13px] text-ink-muted">
          <p className="font-medium text-ink">Scan to connect</p>
          <ol className="mt-2 list-decimal space-y-1 pl-4">
            <li>Open your phone camera and scan this code.</li>
            <li>WhatsApp opens a chat to our number with a prefilled message.</li>
            <li>Send it — you’ll get a confirmation and you’re connected.</li>
          </ol>
          <a
            href={pendingLink.deeplink}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block rounded-md border border-border px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-hover"
          >
            Open WhatsApp instead
          </a>
        </div>
      </div>
    </div>
  );
}

function ConnectedDetails({ whatsapp }: { whatsapp: WhatsAppChannelState }) {
  return (
    <div className="border-t border-border px-4 py-3.5">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-ink-muted">
        <span>
          Last received: <span className="text-ink">{formatTime(whatsapp.lastInboundAt)}</span>
        </span>
        <span>
          Last sent: <span className="text-ink">{formatTime(whatsapp.lastOutboundAt)}</span>
        </span>
      </div>

      {whatsapp.lastError && (
        <div className="mt-2 text-[12px] text-danger">Last error: {whatsapp.lastError}</div>
      )}

      {whatsapp.recentMessages.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
            Recent activity
          </div>
          <div className="mt-1.5 space-y-1">
            {whatsapp.recentMessages.map((message) => (
              <div key={message.id} className="flex items-center gap-2 text-[12px]">
                {message.direction === "inbound" ? (
                  <ArrowDownLeft size={12} className="shrink-0 text-emerald-600" />
                ) : (
                  <ArrowUpRight size={12} className="shrink-0 text-ink-subtle" />
                )}
                <span className="min-w-0 flex-1 truncate text-ink-muted">
                  {message.preview ?? <span className="italic">no preview</span>}
                </span>
                <span className="shrink-0 text-ink-subtle">{formatTime(message.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusPill({
  status,
  linking,
  configured,
}: {
  status: WhatsAppChannelState["status"];
  linking: boolean;
  configured: boolean;
}) {
  let label = "Not connected";
  let tone = "border-border bg-surface text-ink-muted";
  if (!configured) {
    label = "Setup pending";
  } else if (status === "connected") {
    label = "Connected";
    tone = "border-success-border bg-success-bg text-success";
  } else if (linking || status === "pending_link") {
    label = "Linking…";
    tone = "border-warning-border bg-warning-bg text-warning";
  } else if (status === "error") {
    label = "Error";
    tone = "border-danger-border bg-danger-bg text-danger";
  }
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${tone}`}>
      {label}
    </span>
  );
}

function Notice({ tone, children }: { tone: "muted" | "error"; children: React.ReactNode }) {
  const cls =
    tone === "error"
      ? "border-danger-border bg-danger-bg text-danger"
      : "border-border bg-surface/45 text-ink-muted";
  return <div className={`border-t border-border px-4 py-3 text-[12.5px] ${cls}`}>{children}</div>;
}

function formatNumber(waId: string): string {
  return waId.startsWith("+") ? waId : `+${waId}`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
