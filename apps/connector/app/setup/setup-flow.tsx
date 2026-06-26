"use client";

import { Button, buttonVariants } from "@opencompany/ui/components/button";
import { Checkbox } from "@opencompany/ui/components/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { Input } from "@opencompany/ui/components/input";
import { cn } from "@opencompany/ui/lib/utils";
import { useMemo, useState } from "react";

type IntegrationId = "slack" | "linear" | "github";
type Step = 1 | 2 | 3;

type Integration = {
  id: IntegrationId;
  name: string;
  mark: string;
  description: string;
};

const integrations: Integration[] = [
  {
    id: "slack",
    name: "Slack",
    mark: "SL",
    description: "Channels, messages, and team context.",
  },
  {
    id: "linear",
    name: "Linear",
    mark: "LN",
    description: "Issues, projects, and engineering workflow.",
  },
  {
    id: "github",
    name: "GitHub",
    mark: "GH",
    description: "Repos, pull requests, issues, and code search.",
  },
];

const stepLabels = [
  { step: 1, label: "Connect apps" },
  { step: 2, label: "Permissions" },
  { step: 3, label: "Invite team" },
] as const;

const permissionOptions = [
  { id: "read", label: "Read" },
  { id: "write", label: "Write" },
] as const;

function emptyConnections() {
  return Object.fromEntries(integrations.map((integration) => [integration.id, false])) as Record<
    IntegrationId,
    boolean
  >;
}

function emptyPermissions() {
  return Object.fromEntries(
    integrations.map((integration) => [
      integration.id,
      {
        read: true,
        write: false,
      },
    ]),
  ) as Record<IntegrationId, { read: boolean; write: boolean }>;
}

export function SetupFlow() {
  const [step, setStep] = useState<Step>(1);
  const [connections, setConnections] = useState(emptyConnections);
  const [permissions, setPermissions] = useState(emptyPermissions);
  const [activeIntegration, setActiveIntegration] = useState<Integration | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [emails, setEmails] = useState<string[]>([]);

  const connectedIntegrations = useMemo(
    () => integrations.filter((integration) => connections[integration.id]),
    [connections],
  );
  const connectedCount = connectedIntegrations.length;

  function connectActiveIntegration() {
    if (!activeIntegration) return;
    setConnections((current) => ({ ...current, [activeIntegration.id]: true }));
    setActiveIntegration(null);
  }

  function togglePermission(integrationId: IntegrationId, permission: "read" | "write") {
    setPermissions((current) => ({
      ...current,
      [integrationId]: {
        ...current[integrationId],
        [permission]: !current[integrationId][permission],
      },
    }));
  }

  function addEmail() {
    const nextEmail = emailInput.trim();
    if (!nextEmail || emails.includes(nextEmail)) return;
    setEmails((current) => [...current, nextEmail]);
    setEmailInput("");
  }

  return (
    <div className="mt-10">
      <div className="grid gap-px border border-border bg-border sm:grid-cols-3">
        {stepLabels.map((item) => {
          const active = item.step === step;
          const complete = item.step < step;

          return (
            <button
              key={item.step}
              type="button"
              onClick={() => setStep(item.step)}
              className={cn(
                "flex min-h-16 flex-col items-start justify-center bg-background px-4 py-3 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40",
                active && "bg-foreground text-background hover:bg-foreground",
              )}
            >
              <span
                className={cn(
                  "text-[11px] uppercase tracking-[0.2em] text-muted-foreground",
                  active && "text-background/70",
                )}
              >
                Step {item.step}/3
              </span>
              <span className="mt-1 text-sm font-bold">{complete ? "Done" : item.label}</span>
            </button>
          );
        })}
      </div>

      {step === 1 ? (
        <section className="mt-10">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">01 Connect</p>
          <h2 className="mt-4 text-xl font-bold tracking-tight text-foreground">
            Choose the first tools for your team.
          </h2>

          <div className="mt-8 grid gap-px border border-border bg-border">
            {integrations.map((integration) => {
              const connected = connections[integration.id];

              return (
                <button
                  key={integration.id}
                  type="button"
                  onClick={() => setActiveIntegration(integration)}
                  className="grid min-h-24 grid-cols-[auto_1fr] items-center gap-4 bg-background p-5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 sm:grid-cols-[auto_1fr_auto]"
                >
                  <span
                    className={cn(
                      "flex size-11 items-center justify-center border border-border bg-background text-xs font-bold",
                      connected && "border-foreground bg-foreground text-background",
                    )}
                    aria-hidden
                  >
                    {integration.mark}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-foreground">
                      {integration.name}
                    </span>
                    <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                      {integration.description}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "col-span-2 inline-flex h-8 items-center justify-center border border-border px-3 text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground sm:col-span-1",
                      connected && "border-foreground text-foreground",
                    )}
                  >
                    {connected ? "Connected" : "Not connected"}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-border pt-8">
            <Button
              type="button"
              size="lg"
              disabled={connectedCount === 0}
              onClick={() => setStep(2)}
              className="rounded-none font-mono"
            >
              Continue
            </Button>
            <span className="text-sm text-muted-foreground">
              {connectedCount === 0
                ? "Connect at least one tool."
                : `${connectedCount} connected.`}
            </span>
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section className="mt-10">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            02 Permissions
          </p>
          <h2 className="mt-4 text-xl font-bold tracking-tight text-foreground">
            Set access for connected tools.
          </h2>

          <div className="mt-8 grid gap-px border border-border bg-border">
            {connectedIntegrations.map((integration) => (
              <div
                key={integration.id}
                className="grid gap-5 bg-background p-5 sm:grid-cols-[1fr_auto]"
              >
                <div>
                  <p className="text-sm font-bold text-foreground">{integration.name}</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    Default team access
                  </p>
                </div>
                <div className="flex flex-wrap gap-4">
                  {permissionOptions.map((permission) => (
                    <label
                      key={permission.id}
                      className="inline-flex items-center gap-2 text-sm text-foreground"
                    >
                      <Checkbox
                        checked={permissions[integration.id][permission.id]}
                        onCheckedChange={() =>
                          togglePermission(integration.id, permission.id)
                        }
                      />
                      {permission.label}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-border pt-8">
            <Button
              type="button"
              size="lg"
              onClick={() => setStep(3)}
              className="rounded-none font-mono"
            >
              Continue
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setStep(1)}
              className="rounded-none font-mono"
            >
              Back
            </Button>
          </div>
        </section>
      ) : null}

      {step === 3 ? (
        <section className="mt-10">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">03 Invite</p>
          <h2 className="mt-4 text-xl font-bold tracking-tight text-foreground">
            Invite your team.
          </h2>

          <div className="mt-8 border border-border bg-background p-5">
            <div className="flex flex-col gap-3 sm:flex-row">
              <Input
                type="email"
                value={emailInput}
                onChange={(event) => setEmailInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addEmail();
                  }
                }}
                placeholder="teammate@company.com"
                className="rounded-none font-mono"
              />
              <Button type="button" onClick={addEmail} className="rounded-none font-mono">
                Add
              </Button>
            </div>

            {emails.length > 0 ? (
              <div className="mt-5 flex flex-wrap gap-2">
                {emails.map((email) => (
                  <span
                    key={email}
                    className="inline-flex h-8 items-center border border-border px-3 text-sm text-foreground"
                  >
                    {email}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-border pt-8">
            <Button type="button" size="lg" className="rounded-none font-mono">
              Finish setup
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setStep(1)}
              className="rounded-none font-mono"
            >
              Skip
            </Button>
          </div>
        </section>
      ) : null}

      <Dialog
        open={activeIntegration !== null}
        onOpenChange={(open) => !open && setActiveIntegration(null)}
      >
        <DialogContent className="rounded-none font-mono sm:max-w-md">
          {activeIntegration ? (
            <>
              <DialogHeader>
                <DialogTitle>Connect {activeIntegration.name}</DialogTitle>
                <DialogDescription>{activeIntegration.description}</DialogDescription>
              </DialogHeader>
              <div className="border border-border bg-background p-4">
                <div className="flex items-center gap-4">
                  <span
                    className="flex size-11 items-center justify-center border border-foreground bg-foreground text-xs font-bold text-background"
                    aria-hidden
                  >
                    {activeIntegration.mark}
                  </span>
                  <div>
                    <p className="text-sm font-bold text-foreground">Mock OAuth</p>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      This prototype marks {activeIntegration.name} as connected.
                    </p>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <DialogClose
                  className={cn(buttonVariants({ variant: "ghost" }), "rounded-none font-mono")}
                >
                  Cancel
                </DialogClose>
                <Button
                  type="button"
                  onClick={connectActiveIntegration}
                  className="rounded-none font-mono"
                >
                  Connect
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
