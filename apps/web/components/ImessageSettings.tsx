"use client";

import type { ImessageSettingsDto } from "@opencompany/protocol";
import { Button } from "@opencompany/ui/components/button";
import { Check, Copy, MessageCircle, Smartphone } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { PageContent } from "@/components/PageContent";
import { startImessageLinkAction, unlinkImessageAction } from "@/lib/imessage-actions";

const POLL_INTERVAL_MS = 4_000;

export function ImessageSettings({ data }: { data: ImessageSettingsDto }) {
  return (
    <PageContent
      title="iMessage"
      description="Text a personal assistant from your phone. It answers with web search, the Wiki, Skills and your connected plugins."
    >
      {!data.configured ? (
        <p className="text-[13px] leading-5 text-ink-subtle">
          iMessage isn&apos;t available on this deployment yet.
        </p>
      ) : (
        <ImessagePanel data={data} />
      )}
    </PageContent>
  );
}

function ImessagePanel({ data }: { data: ImessageSettingsDto }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const binding = data.binding;
  const linked = binding?.status === "linked";
  const pendingExpiresAt = binding?.status === "pending" ? binding.linkCodeExpiresAt : null;
  const codeExpired = useCodeExpired(pendingExpiresAt);
  const awaitingText = binding?.status === "pending" && !codeExpired && binding.linkCode !== null;

  // Linking completes on the phone, not in this tab: keep re-reading until the webhook has bound
  // the number or the code has lapsed.
  useEffect(() => {
    if (!awaitingText) return;
    const timer = window.setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [awaitingText, router]);

  const run = (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <p className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] leading-5 text-danger">
          {error}
        </p>
      ) : null}

      {linked ? (
        <section className="flex flex-col gap-4 rounded-lg border border-line px-4 py-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-muted text-ink">
              <Check size={15} strokeWidth={2} />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-[13px] font-medium text-ink">Linked to {binding.handle}</p>
              <p className="text-[13px] leading-5 text-ink-subtle">
                Text {formatHandle(data.lineHandle)} from this number and your assistant replies
                there. Everything it does is saved to one conversation in the app.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {binding.conversationId ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/chat/${binding.conversationId}`}>
                  <MessageCircle size={14} strokeWidth={1.75} />
                  Open conversation
                </Link>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => run(unlinkImessageAction)}
            >
              Unlink phone
            </Button>
          </div>
        </section>
      ) : awaitingText ? (
        <LinkCodeCard
          code={binding.linkCode ?? ""}
          lineHandle={data.lineHandle ?? ""}
          expiresAt={binding.linkCodeExpiresAt}
          pending={pending}
          onNewCode={() => run(startImessageLinkAction)}
        />
      ) : (
        <section className="flex flex-col gap-4 rounded-lg border border-line px-4 py-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-muted text-ink">
              <Smartphone size={15} strokeWidth={1.75} />
            </span>
            <div className="flex flex-col gap-0.5">
              <p className="text-[13px] font-medium text-ink">Link your phone</p>
              <p className="text-[13px] leading-5 text-ink-subtle">
                {codeExpired
                  ? "Your last code expired. Get a new one and text it within ten minutes."
                  : "You'll get a six-digit code to text to the opencompany number. That pairs this account with your phone."}
              </p>
            </div>
          </div>
          <div>
            <Button size="sm" disabled={pending} onClick={() => run(startImessageLinkAction)}>
              {codeExpired ? "Get a new code" : "Get a code"}
            </Button>
          </div>
        </section>
      )}

      <p className="text-[12px] leading-5 text-ink-subtle">
        The assistant runs with your access in this workspace. Actions that need approval are
        declined over iMessage; run those from the app.
      </p>
    </div>
  );
}

// Expiry is wall-clock state read through an external-store subscription, so the card flips to
// "expired" on its own without a reload while render itself stays pure.
function useCodeExpired(expiresAt: string | null) {
  const deadline = expiresAt ? new Date(expiresAt).getTime() : null;
  return useSyncExternalStore(
    (onChange) => {
      const timer = window.setInterval(onChange, 1_000);
      return () => window.clearInterval(timer);
    },
    () => deadline !== null && Date.now() >= deadline,
    () => false,
  );
}

function LinkCodeCard({
  code,
  lineHandle,
  expiresAt,
  pending,
  onNewCode,
}: {
  code: string;
  lineHandle: string;
  expiresAt: string | null;
  pending: boolean;
  onNewCode: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const smsHref = `sms:${lineHandle}&body=${encodeURIComponent(code)}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line px-4 py-4">
      <div className="flex flex-col gap-1">
        <p className="text-[13px] font-medium text-ink">
          Text this code to {formatHandle(lineHandle)}
        </p>
        <p className="text-[13px] leading-5 text-ink-subtle">
          From the phone you want to use. This page updates on its own once the text arrives.
          {expiresAt ? ` The code expires at ${formatTime(expiresAt)}.` : ""}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-label="Link code"
          className="rounded-md bg-surface-muted px-3 py-2 font-mono text-[22px] font-semibold tracking-[0.25em] text-ink"
        >
          {code}
        </span>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.75} />}
          {copied ? "Copied" : "Copy code"}
        </Button>
        <Button asChild size="sm">
          <a href={smsHref}>
            <MessageCircle size={14} strokeWidth={1.75} />
            Open Messages
          </a>
        </Button>
      </div>
      <div className="flex items-center gap-2 text-[12px] text-ink-subtle">
        <span className="size-1.5 animate-pulse rounded-full bg-ink/50" aria-hidden />
        Waiting for your text…
        <button
          type="button"
          className="ml-auto text-ink-subtle underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
          disabled={pending}
          onClick={onNewCode}
        >
          New code
        </button>
      </div>
    </section>
  );
}

function formatHandle(handle: string | null) {
  if (!handle) return "the opencompany number";
  const digits = handle.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return handle;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
