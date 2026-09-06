"use client";

import { ExternalLink, Globe2, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import {
  completeHeadlessBrowserProfileLogin,
  createHeadlessBrowserProfile,
  createHeadlessBrowserProfileLoginSession,
  deleteHeadlessBrowserProfile,
  listHeadlessBrowserProfiles,
} from "@/lib/headless-browser-profile-api";

type BrowserProfileView = {
  id: string;
  name: string;
  siteHost: string;
  status: "pending_login" | "connected" | "needs_reauth" | "disconnected";
  active: boolean;
};

type LoginSessionView = {
  profileId: string;
  sessionId: string;
  liveViewUrl: string;
};

export function BrowserProfilesSettings() {
  const [profiles, setProfiles] = useState<BrowserProfileView[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [loginSession, setLoginSession] = useState<LoginSessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const refresh = async () => {
    const loaded = await listHeadlessBrowserProfiles();
    setProfiles(
      loaded.map((profile) => ({
        id: profile.id,
        name: profile.name,
        siteHost: profile.siteHost,
        status: profile.status,
        active: profile.active,
      })),
    );
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh().catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Could not load browser profiles."),
    );
  }, []);

  const startLogin = async (profileId: string) => {
    const session = await createHeadlessBrowserProfileLoginSession(profileId);
    setLoginSession({
      profileId,
      sessionId: session.sessionId,
      liveViewUrl: session.liveViewUrl,
    });
  };

  const createAndLogin = () => {
    setError(null);
    startTransition(async () => {
      try {
        const created = await createHeadlessBrowserProfile({ name, url });
        setName("");
        setUrl("");
        await startLogin(created.id);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not connect browser profile.");
      }
    });
  };

  const completeLogin = () => {
    if (!loginSession) return;
    setError(null);
    startTransition(async () => {
      try {
        await completeHeadlessBrowserProfileLogin(loginSession.profileId, loginSession.sessionId);
        setLoginSession(null);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not complete login.");
      }
    });
  };

  const deleteProfile = (profileId: string) => {
    setError(null);
    startTransition(async () => {
      try {
        await deleteHeadlessBrowserProfile(profileId);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not delete browser profile.");
      }
    });
  };

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <div className="flex items-start gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-[#0F766E] text-white">
          <Globe2 size={24} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold leading-tight text-ink">Browser profiles</h2>
          <p className="mt-1 text-[13px] leading-5 text-ink-subtle">
            Saved login sessions for authenticated browser tasks.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Profile name"
          className="h-9 rounded-lg border border-border bg-canvas px-3 text-[13px] text-ink outline-none focus:border-ink/30"
        />
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com"
          className="h-9 rounded-lg border border-border bg-canvas px-3 text-[13px] text-ink outline-none focus:border-ink/30"
        />
        <button
          type="button"
          onClick={createAndLogin}
          disabled={isPending}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-ink px-3 text-[13px] font-medium text-canvas disabled:opacity-60"
        >
          {isPending ? <Loader2 size={14} className="animate-spin" /> : null}
          Connect
        </button>
      </div>
      {profiles.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {profiles.map((profile) => (
            <div
              key={profile.id}
              className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium leading-4 text-ink">
                  {profile.name}
                </div>
                <div className="truncate text-[12px] leading-4 text-ink-subtle">
                  {profile.siteHost}
                </div>
              </div>
              <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle">
                {profile.active ? "Active" : profile.status.replace("_", " ")}
              </span>
              {profile.status === "connected" ? null : (
                <button
                  type="button"
                  onClick={() =>
                    startTransition(() =>
                      startLogin(profile.id).catch((cause) =>
                        setError(cause instanceof Error ? cause.message : "Could not start login."),
                      ),
                    )
                  }
                  disabled={isPending}
                  className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-ink-subtle hover:bg-surface-hover hover:text-ink disabled:opacity-60"
                >
                  Reconnect
                </button>
              )}
              <button
                type="button"
                onClick={() => deleteProfile(profile.id)}
                disabled={isPending}
                aria-label={`Delete ${profile.name}`}
                className="inline-flex size-7 items-center justify-center rounded-full text-ink-subtle hover:bg-surface-hover hover:text-ink disabled:opacity-60"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {loginSession ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-canvas p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] font-medium text-ink">Login handoff</span>
            <a
              href={loginSession.liveViewUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-subtle hover:text-ink"
            >
              Open
              <ExternalLink size={13} />
            </a>
          </div>
          <iframe
            src={loginSession.liveViewUrl}
            className="h-[420px] w-full rounded-lg border border-border bg-surface"
            title="Browser profile login"
          />
          <div>
            <button
              type="button"
              onClick={completeLogin}
              disabled={isPending}
              className="inline-flex h-9 items-center justify-center rounded-lg bg-ink px-3 text-[13px] font-medium text-canvas disabled:opacity-60"
            >
              I&apos;m logged in
            </button>
          </div>
        </div>
      ) : null}
      {error ? <div className="text-[12px] leading-4 text-warning">{error}</div> : null}
    </section>
  );
}
