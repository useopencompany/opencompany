"use client";

import { Check, ExternalLink, Images, LogIn, ShieldAlert, Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { GoatIntegrationAccountView } from "@/lib/integration-state";
import {
  disconnectKleinanzeigenAction,
  saveKleinanzeigenBrowserUseApiKeyAction,
  startKleinanzeigenLoginAction,
  stopKleinanzeigenLoginAction,
} from "@/lib/integrations/kleinanzeigen-actions";

type LoginSession = { sessionId: string; liveUrl: string };

export function KleinanzeigenIntegrationSetup({
  initialAccount,
}: {
  initialAccount: GoatIntegrationAccountView | null;
}) {
  const router = useRouter();
  const [account, setAccount] = useState(initialAccount);
  const [apiKey, setApiKey] = useState("");
  const [loginSession, setLoginSession] = useState<LoginSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const connected = account?.connected === true;

  function connect() {
    setError(null);
    startTransition(async () => {
      const result = await saveKleinanzeigenBrowserUseApiKeyAction(apiKey);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAccount(result.account);
      setApiKey("");
      router.refresh();
    });
  }

  function startLogin() {
    setError(null);
    startTransition(async () => {
      const result = await startKleinanzeigenLoginAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLoginSession(result);
    });
  }

  function finishLogin() {
    if (!loginSession) return;
    setError(null);
    startTransition(async () => {
      const result = await stopKleinanzeigenLoginAction(loginSession.sessionId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLoginSession(null);
    });
  }

  function disconnect() {
    setError(null);
    startTransition(async () => {
      const result = await disconnectKleinanzeigenAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAccount(null);
      setLoginSession(null);
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
            <span className="text-[14px] font-medium leading-tight text-ink">
              {connected ? "Ready for approved listings" : "Not connected"}
            </span>
            <span className="text-[12px] leading-4 text-ink-subtle">
              {connected
                ? "Chat can start an approved listing run with your persistent browser profile."
                : "Connect a Browser Use project, then sign into Kleinanzeigen once."}
            </span>
          </div>
          <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle">
            {connected ? "Connected" : "Setup"}
          </span>
        </div>
      </section>

      {!connected ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
            Browser Use API key
          </h2>
          <label className="flex flex-col gap-1 px-2">
            <span className="text-[12px] leading-4 text-ink-subtle">Personal API key</span>
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste your Browser Use API key"
              disabled={isPending}
              className="h-9 rounded-md border border-border bg-surface px-2.5 font-mono text-[13px] text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-border-strong disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
          <div className="flex flex-col items-start gap-3 px-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0 text-[12px] leading-4 text-ink-subtle">
              Encrypted at rest and never shown to the chat model. Browser runs use your Browser Use
              credits; each listing agent session is capped at $0.75.
            </span>
            <button
              type="button"
              onClick={connect}
              disabled={isPending || apiKey.trim().length === 0}
              className="inline-flex shrink-0 items-center gap-2 rounded-md bg-ink px-3 py-2 text-[13px] font-medium leading-none text-canvas transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check size={14} />
              Connect
            </button>
          </div>
        </section>
      ) : (
        <section className="flex flex-col gap-3">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
            Kleinanzeigen login
          </h2>
          <div className="mx-2 flex items-start gap-2 rounded-md border border-border bg-surface-muted px-2.5 py-2">
            <LogIn size={14} className="mt-0.5 shrink-0 text-ink" />
            <span className="text-[12px] leading-5 text-ink-subtle">
              Open a private browser, sign into Kleinanzeigen yourself, then finish the session.
              Cookies stay in a dedicated Browser Use profile; OpenCompany never receives your
              password.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 px-2">
            {!loginSession ? (
              <button
                type="button"
                onClick={startLogin}
                disabled={isPending}
                className="inline-flex items-center gap-2 rounded-md bg-ink px-3 py-2 text-[13px] font-medium leading-none text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                <LogIn size={14} />
                Open login browser
              </button>
            ) : (
              <>
                <a
                  href={loginSession.liveUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-md bg-ink px-3 py-2 text-[13px] font-medium leading-none text-canvas transition-opacity hover:opacity-90"
                >
                  <ExternalLink size={14} />
                  Continue in browser
                </a>
                <button
                  type="button"
                  onClick={finishLogin}
                  disabled={isPending}
                  className="inline-flex items-center gap-2 rounded-md border border-ink/15 px-3 py-2 text-[13px] font-medium leading-none text-ink transition-colors hover:bg-surface-hover disabled:opacity-50"
                >
                  <Square size={12} />
                  I’m signed in — stop
                </button>
              </>
            )}
            <button
              type="button"
              onClick={disconnect}
              disabled={isPending}
              className="inline-flex items-center rounded-md px-3 py-2 text-[13px] font-medium leading-none text-warning transition-colors hover:bg-surface-hover disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
        </section>
      )}

      {error ? <p className="px-2 text-[12px] leading-4 text-warning">{error}</p> : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          How the first version works
        </h2>
        <div className="mx-2 grid gap-2 sm:grid-cols-2">
          <SetupNote
            icon={<Images size={14} />}
            title="Paste 1–5 images"
            detail="Add the item details in main Chat. Goat proposes one exact listing action for approval."
          />
          <SetupNote
            icon={<ShieldAlert size={14} />}
            title="Human stops stay human"
            detail="Login, 2FA, CAPTCHA, unexpected fields, and every fee hand back a live browser instead of being bypassed."
          />
        </div>
        <p className="px-2 text-[12px] leading-5 text-ink-subtle">
          This beta uses browser automation because Kleinanzeigen has no supported consumer listing
          API. Use it only for your own account and listings, review each approval carefully, and
          follow Kleinanzeigen’s terms. The agent publishes only when placement costs €0, uses the
          exact approved values, and verifies the resulting URL.
        </p>
        <a
          href="https://cloud.browser-use.com"
          target="_blank"
          rel="noreferrer"
          className="mx-2 inline-flex w-fit items-center gap-1 text-[12px] font-medium text-ink underline underline-offset-2"
        >
          Open Browser Use
          <ExternalLink size={12} />
        </a>
      </section>
    </div>
  );
}

function SetupNote({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <div className="mb-1 flex items-center gap-2 text-[12px] font-medium text-ink">
        {icon}
        {title}
      </div>
      <p className="text-[12px] leading-4 text-ink-subtle">{detail}</p>
    </div>
  );
}
