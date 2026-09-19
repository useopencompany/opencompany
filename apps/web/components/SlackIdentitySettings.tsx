"use client";

import { Button } from "@opencompany/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { Input } from "@opencompany/ui/components/input";
import { Check, Copy, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  completeSlackProvisioning,
  confirmSlackProvisioning,
  disconnectSlackProvisioning,
  getSlackProvisioning,
  startSlackProvisioning,
} from "@/lib/company-agent-commands";

export function SlackIdentitySettings() {
  const [data, setData] = useState<Awaited<ReturnType<typeof getSlackProvisioning>> | null>(null);
  const [attempt, setAttempt] = useState<Awaited<ReturnType<typeof startSlackProvisioning>> | null>(
    null,
  );
  const [open, setOpen] = useState(false);
  const [pendingTeam, setPendingTeam] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  useEffect(() => {
    let disposed = false;
    void getSlackProvisioning()
      .then((value) => {
        if (!disposed) setData(value);
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, []);
  async function start() {
    setBusy(true);
    setError(null);
    setAttempt(null);
    setCode("");
    setPendingTeam(null);
    setCopied(false);
    try {
      setAttempt(await startSlackProvisioning());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Setup could not start.");
    } finally {
      setBusy(false);
    }
  }
  if (!data && !error)
    return (
      <section className="mt-6 rounded-xl border border-border p-5 text-[13px] text-ink-subtle">
        Loading Slack identity settings…
      </section>
    );
  return (
    <section className="mt-6 rounded-xl border border-border p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium">Company agent identities</h2>
          <p className="mt-1 max-w-xl text-[13px] leading-5 text-ink-subtle">
            Give each agent its own Slack profile. Teammates can @mention it in channels or send it
            a direct message.
          </p>
        </div>
        {data?.configured ? (
          <span className="flex shrink-0 items-center gap-1 text-xs">
            <Check className="size-3.5" /> Connected
          </span>
        ) : null}
      </div>
      {data?.configured ? (
        <p className="mt-4 text-[13px]">
          Connected to <strong>{data.teamName}</strong>. Slack stays off for every agent until its
          owner turns it on.
        </p>
      ) : (
        <p className="mt-4 text-[13px] text-ink-subtle">
          {data?.status === "needs_reauth"
            ? "Slack access needs to be renewed. Existing identities are kept."
            : "An admin authorizes your Slack workspace once. New identities are created automatically when an agent’s Slack toggle is turned on."}
        </p>
      )}
      <p className="mt-2 text-xs text-ink-subtle">
        The opencompany bot keeps its own identity and connection.
      </p>
      {error && !open ? (
        <p role="alert" className="mt-3 text-[13px] text-red-600">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setOpen(true);
            setAttempt(null);
            setPendingTeam(null);
            setError(null);
          }}
        >
          {data?.configured ? "Renew authorization" : "Set up identities"}
        </Button>
        {data?.configured ? (
          <Button size="sm" variant="ghost" onClick={() => setConfirmDisconnect(true)}>
            Disconnect
          </Button>
        ) : null}
      </div>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Set up Slack identities</DialogTitle>
            <DialogDescription>
              Authorize the Slack workspace where your agents will live. You need permission to
              create and install apps there.
            </DialogDescription>
          </DialogHeader>
          {pendingTeam && attempt ? (
            <div className="space-y-4">
              <p className="text-sm">
                Slack authorized <strong>{pendingTeam}</strong>. Connect this workspace for company
                agent identities?
              </p>
              <p className="text-[13px] text-ink-subtle">
                Only agents with Slack turned on will receive an identity. The opencompany bot
                remains separate.
              </p>
              <div className="flex justify-between gap-2">
                <Button variant="ghost" disabled={busy} onClick={() => void start()}>
                  Use another workspace
                </Button>
                <Button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      setData(await confirmSlackProvisioning(attempt.attemptId));
                      setOpen(false);
                      setAttempt(null);
                      setPendingTeam(null);
                    } catch (e) {
                      setError(
                        e instanceof Error ? e.message : "Slack workspace could not be connected.",
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Connecting…" : "Connect workspace"}
                </Button>
              </div>
            </div>
          ) : !attempt ? (
            <>
              <p className="text-sm leading-6 text-ink-subtle">
                This grants opencompany persistent developer access to create and manage Slack apps
                in your workspace. Your Slack app approval rules still apply. Agent owners can then
                turn Slack on without repeating this setup.
              </p>
              <p className="text-sm leading-6 text-ink-subtle">
                Slack is off by default for new and existing agents. The opencompany bot remains
                separate.
              </p>
              <Button disabled={busy} onClick={() => void start()}>
                {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}Continue to Slack
                setup
              </Button>
            </>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError(null);
                try {
                  const verified = await completeSlackProvisioning(attempt.attemptId, code.trim());
                  setPendingTeam(verified.teamName);
                  setCode("");
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Slack could not verify this code.");
                  setAttempt(null);
                } finally {
                  setBusy(false);
                }
              }}
              className="space-y-4"
            >
              <div>
                <p className="mb-2 text-sm font-medium">
                  1. Run this command in your Slack workspace
                </p>
                <p className="mb-3 text-[13px] leading-5 text-ink-subtle">
                  Paste it into any conversation in Slack, including a message to yourself, and send
                  it. Follow Slack’s authorization prompt.
                </p>
                <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/30 p-3">
                  <code className="min-w-0 flex-1 break-all text-xs">{attempt.command}</code>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label="Copy Slack command"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(attempt.command);
                        setCopied(true);
                      } catch {
                        setError("Select and copy the command above.");
                      }
                    }}
                  >
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  </Button>
                </div>
              </div>
              <div>
                <label htmlFor="slack-identity-code" className="mb-2 block text-sm font-medium">
                  2. Paste the verification code Slack gives you
                </label>
                <Input
                  id="slack-identity-code"
                  autoComplete="off"
                  spellCheck={false}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Verification code"
                  maxLength={128}
                  required
                />
                <p className="mt-2 text-xs text-ink-subtle">
                  This command expires after 10 minutes. Keep the code private.
                </p>
              </div>
              <div className="flex items-center justify-between gap-2">
                <Button type="button" variant="ghost" disabled={busy} onClick={() => void start()}>
                  Get a new command
                </Button>
                <Button type="submit" disabled={busy || !code.trim()}>
                  {busy ? "Verifying…" : "Verify code"}
                </Button>
              </div>
            </form>
          )}
          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect identity setup?</DialogTitle>
            <DialogDescription>
              New identities and profile updates will stop. Existing agent bots and the opencompany
              bot will keep working. Turn off Slack on an agent to stop its replies.
            </DialogDescription>
          </DialogHeader>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setData(await disconnectSlackProvisioning());
                setConfirmDisconnect(false);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Disconnect failed.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Disconnect setup
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  );
}
