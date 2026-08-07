"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { disconnectIntegrationAccountAction } from "@/lib/integration-account-actions";
import type { ImessageProviderState } from "@/lib/integration-state";
import {
  confirmImessagePairingAction,
  startImessagePairingAction,
} from "@/lib/integrations/imessage-actions";

export function IMessageIntegrationSetup({
  initialState,
}: {
  initialState: ImessageProviderState;
}) {
  const router = useRouter();
  const [state, setState] = useState(initialState);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const status = setupStatus(state);

  function sendCode() {
    setError(null);
    startTransition(async () => {
      const result = await startImessagePairingAction(phone);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCode("");
      setCodeSent(true);
    });
  }

  function verifyCode() {
    setError(null);
    startTransition(async () => {
      const result = await confirmImessagePairingAction(code);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setState(result.state);
      setPhone("");
      setCode("");
      setCodeSent(false);
      router.refresh();
    });
  }

  function disconnect() {
    if (!state.integrationId) return;
    setError(null);
    startTransition(async () => {
      const result = await disconnectIntegrationAccountAction(state.integrationId as string);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setState({
        provider: "imessage",
        connected: false,
        status: "not_connected",
        integrationId: null,
        phoneE164: null,
        statusReason: null,
      });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-1">
        <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Status
        </h2>
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[14px] font-medium leading-tight text-ink">{status.label}</span>
            {status.detail ? (
              <span className="text-[12px] leading-4 text-ink-subtle">{status.detail}</span>
            ) : null}
          </div>
          <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle">
            {status.badge}
          </span>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          {state.connected ? "Paired phone" : "Pair your phone"}
        </h2>
        {state.connected ? (
          <>
            <div className="mx-2 flex items-start gap-2 rounded-md border border-border bg-surface-muted px-2.5 py-2">
              <Check size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-ink" />
              <div className="min-w-0">
                <span className="block text-[13px] font-medium leading-5 text-ink">
                  {state.phoneE164 ?? "Phone paired"}
                </span>
                <span className="block text-[12px] leading-4 text-ink-subtle">
                  opencompany can text this number. Disconnect to pair a different one.
                </span>
              </div>
            </div>
            {error ? <p className="px-2 text-[12px] leading-4 text-warning">{error}</p> : null}
            <div className="px-2">
              <button
                type="button"
                onClick={disconnect}
                disabled={isPending}
                className="inline-flex items-center rounded-md border border-ink/15 px-3 py-2 text-[13px] font-medium leading-none text-ink transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="flex flex-col gap-1 px-2">
              <span className="text-[12px] leading-4 text-ink-subtle">Phone number</span>
              <input
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                type="tel"
                autoComplete="tel"
                spellCheck={false}
                placeholder="+14155551234"
                disabled={isPending}
                className="h-9 rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-border-strong disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
            {codeSent ? (
              <label className="flex flex-col gap-1 px-2">
                <span className="text-[12px] leading-4 text-ink-subtle">Verification code</span>
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  spellCheck={false}
                  placeholder="6-digit code"
                  maxLength={6}
                  disabled={isPending}
                  className="h-9 rounded-md border border-border bg-surface px-2.5 text-[13px] tracking-[0.2em] text-ink outline-none transition-colors placeholder:tracking-normal placeholder:text-ink-subtle focus:border-border-strong disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>
            ) : null}
            {error ? <p className="px-2 text-[12px] leading-4 text-warning">{error}</p> : null}
            <div className="flex flex-col items-start gap-3 px-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0 text-[12px] leading-4 text-ink-subtle">
                {codeSent
                  ? "We texted a 6-digit code to your number."
                  : "We'll text a verification code to this number over iMessage."}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                {codeSent ? (
                  <>
                    <button
                      type="button"
                      onClick={sendCode}
                      disabled={isPending || phone.trim().length === 0}
                      className="inline-flex items-center rounded-md border border-ink/15 px-3 py-2 text-[13px] font-medium leading-none text-ink transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Resend code
                    </button>
                    <button
                      type="button"
                      onClick={verifyCode}
                      disabled={isPending || code.trim().length !== 6}
                      className="inline-flex items-center gap-2 rounded-md bg-ink px-3 py-2 text-[13px] font-medium leading-none text-canvas transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Check size={14} strokeWidth={2} />
                      Verify
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={sendCode}
                    disabled={isPending || phone.trim().length === 0}
                    className="inline-flex items-center gap-2 rounded-md bg-ink px-3 py-2 text-[13px] font-medium leading-none text-canvas transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Send code
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          How it works
        </h2>
        <ol className="list-decimal space-y-2 pl-6 text-[13px] leading-5 text-ink-subtle">
          <li>Enter your phone number and we text you a verification code over iMessage.</li>
          <li>Enter the code to pair the number.</li>
          <li>
            Once paired, ask opencompany to text you — for example &quot;text me when this task
            finishes&quot; — and it can send you one-way updates.
          </li>
        </ol>
        <p className="px-2 text-[13px] leading-5 text-ink-subtle">
          Messages are one-way for now: opencompany can text you, but replies to those messages are not
          read.
        </p>
      </section>
    </div>
  );
}

function setupStatus(state: ImessageProviderState) {
  if (state.connected) {
    return {
      label: state.phoneE164 ? `Paired with ${state.phoneE164}` : "iMessage is paired",
      detail: "opencompany can text you important updates on this number.",
      badge: "Connected",
    };
  }
  return {
    label: "Not paired",
    detail: "Verify your phone number so opencompany can text you updates.",
    badge: "Setup",
  };
}
