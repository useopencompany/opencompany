"use client";

import { Button, buttonVariants } from "@opencompany/ui/components/button";
import { Checkbox } from "@opencompany/ui/components/checkbox";
import { Input } from "@opencompany/ui/components/input";
import { CheckCircle2, LinearIcon, Link, Lock } from "@opencompany/ui/icons";
import { cn } from "@opencompany/ui/lib/utils";
import { useActionState, useEffect, useMemo, useState } from "react";
import { describeConnectorLinearStatus } from "@/lib/mcp/status";
import {
  CONNECTOR_LINEAR_PERMISSION_LABELS,
  CONNECTOR_LINEAR_PERMISSION_SCOPES,
  type ConnectorLinearPermissionScope,
  type ConnectorLinearPermissions,
} from "@/lib/permissions";
import { finishConnectorSetupAction, saveConnectorOrganizationAction } from "@/lib/setup/actions";
import type { ConnectorSetupState, SerializedConnectorOrganization } from "@/lib/setup/data";
import {
  initialFinishSetupActionState,
  type OrganizationActionState,
  type setupStatusMessage,
} from "@/lib/setup/state";
import { slugifyConnectorOrganizationName } from "@/lib/slug";

type Step = 1 | 2 | 3;
type SetupNotice = ReturnType<typeof setupStatusMessage>;

type SetupFlowProps = {
  initialState: ConnectorSetupState;
  notice: SetupNotice;
};

const stepLabels = [
  { step: 1, label: "Organization" },
  { step: 2, label: "Linear" },
  { step: 3, label: "Permissions" },
] as const;

export function SetupFlow({ initialState, notice }: SetupFlowProps) {
  const [organization, setOrganization] = useState(initialState.organization);
  const [step, setStep] = useState<Step>(() => initialStep(initialState));
  const [name, setName] = useState(initialState.organization?.name ?? "");
  const [slug, setSlug] = useState(initialState.organization?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(Boolean(initialState.organization?.slug));
  const [permissions, setPermissions] = useState<ConnectorLinearPermissions>(
    initialState.permissions,
  );

  const initialOrganizationState: OrganizationActionState = useMemo(
    () => ({ error: null, organization }),
    [organization],
  );
  const [organizationState, organizationAction, organizationPending] = useActionState(
    saveConnectorOrganizationAction,
    initialOrganizationState,
  );
  const [finishState, finishAction, finishPending] = useActionState(
    finishConnectorSetupAction,
    initialFinishSetupActionState,
  );

  useEffect(() => {
    if (!organizationState.organization) return;
    setOrganization(organizationState.organization);
    setName(organizationState.organization.name);
    setSlug(organizationState.organization.slug);
    setStep(2);
  }, [organizationState.organization]);

  function updatePermission(scope: ConnectorLinearPermissionScope, checked: boolean) {
    setPermissions((current) => ({ ...current, [scope]: checked }));
  }

  function updateName(nextName: string) {
    setName(nextName);
    if (!slugTouched) {
      setSlug(slugifyConnectorOrganizationName(nextName));
    }
  }

  const linearConnected = initialState.linear.configured;
  const linearStatus = describeConnectorLinearStatus(initialState.linear);

  return (
    <div className="mt-10">
      <div className="grid gap-px border border-border bg-border sm:grid-cols-3">
        {stepLabels.map((item) => {
          const active = item.step === step;
          const complete = isStepComplete(item.step, organization, linearConnected);
          const disabled =
            (item.step === 2 && !organization) || (item.step === 3 && !linearConnected);

          return (
            <button
              key={item.step}
              type="button"
              onClick={() => {
                if (!disabled) setStep(item.step);
              }}
              disabled={disabled}
              className={cn(
                "flex min-h-16 flex-col items-start justify-center bg-background px-4 py-3 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
                active && "bg-foreground text-background hover:bg-foreground",
              )}
            >
              <span
                className={cn(
                  "text-[11px] uppercase text-muted-foreground",
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

      {notice ? (
        <div
          className={cn(
            "mt-6 border px-4 py-3 text-sm",
            notice.type === "success"
              ? "border-foreground text-foreground"
              : "border-destructive text-destructive",
          )}
        >
          {notice.text}
        </div>
      ) : null}

      {step === 1 ? (
        <OrganizationStep
          action={organizationAction}
          pending={organizationPending}
          error={organizationState.error}
          name={name}
          slug={slug}
          onNameChange={updateName}
          onSlugChange={(nextSlug) => {
            setSlugTouched(true);
            setSlug(slugifyConnectorOrganizationName(nextSlug));
          }}
        />
      ) : null}

      {step === 2 ? (
        <LinearStep
          organization={organization}
          connected={linearConnected}
          statusLabel={linearStatus.label}
          statusTone={linearStatus.tone}
          statusDetail={linearStatus.detail}
          updatedAt={initialState.linear.updatedAt}
          onBack={() => setStep(1)}
          onContinue={() => setStep(3)}
        />
      ) : null}

      {step === 3 ? (
        <PermissionsStep
          action={finishAction}
          pending={finishPending}
          error={finishState.error}
          permissions={permissions}
          onPermissionChange={updatePermission}
          onBack={() => setStep(2)}
        />
      ) : null}
    </div>
  );
}

function OrganizationStep({
  action,
  pending,
  error,
  name,
  slug,
  onNameChange,
  onSlugChange,
}: {
  action: (formData: FormData) => void;
  pending: boolean;
  error: string | null;
  name: string;
  slug: string;
  onNameChange: (name: string) => void;
  onSlugChange: (slug: string) => void;
}) {
  return (
    <section className="mt-10">
      <p className="text-xs uppercase text-muted-foreground">01 Organization</p>
      <h2 className="mt-4 text-xl font-bold tracking-tight text-foreground">
        Set up your Connector organization.
      </h2>

      <form action={action} className="mt-8 border border-border bg-background p-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-bold text-foreground">Name</span>
            <Input
              name="name"
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder="Acme"
              className="mt-2 rounded-none font-mono"
              required
            />
          </label>
          <label className="block">
            <span className="text-sm font-bold text-foreground">Slug</span>
            <Input
              name="slug"
              value={slug}
              onChange={(event) => onSlugChange(event.target.value)}
              placeholder="acme"
              className="mt-2 rounded-none font-mono"
              required
            />
          </label>
        </div>

        {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}

        <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-border pt-8">
          <Button type="submit" size="lg" disabled={pending} className="rounded-none font-mono">
            {pending ? "Saving..." : "Continue"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function LinearStep({
  organization,
  connected,
  statusLabel,
  statusTone,
  statusDetail,
  updatedAt,
  onBack,
  onContinue,
}: {
  organization: SerializedConnectorOrganization | null;
  connected: boolean;
  statusLabel: string;
  statusTone: "success" | "warning" | "error" | "muted";
  statusDetail: string;
  updatedAt: string | null;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <section className="mt-10">
      <p className="text-xs uppercase text-muted-foreground">02 Linear</p>
      <h2 className="mt-4 text-xl font-bold tracking-tight text-foreground">
        Connect Linear through remote MCP.
      </h2>

      <div className="mt-8 grid gap-px border border-border bg-border">
        <div className="grid gap-5 bg-background p-5 sm:grid-cols-[auto_1fr_auto] sm:items-center">
          <span
            className={cn(
              "flex size-11 items-center justify-center border border-border bg-background text-foreground",
              connected && "border-foreground bg-foreground text-background",
            )}
          >
            <LinearIcon size={20} />
          </span>
          <div>
            <p className="text-sm font-bold text-foreground">Linear</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Issues, projects, comments, and engineering workflow via Linear MCP.
            </p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{statusDetail}</p>
            {updatedAt ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Last updated {formatConnectorTimestamp(updatedAt)}
              </p>
            ) : null}
          </div>
          <span
            className={cn(
              "inline-flex h-8 items-center justify-center border border-border px-3 text-xs font-bold uppercase text-muted-foreground",
              connected && "border-foreground text-foreground",
              statusTone === "error" && "border-destructive text-destructive",
            )}
          >
            {statusLabel}
          </span>
        </div>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-border pt-8">
        <a
          href="/api/mcp/linear/start?returnTo=/setup"
          className={cn(buttonVariants({ size: "lg" }), "rounded-none font-mono")}
          aria-disabled={!organization}
        >
          {connected ? (
            <>
              <CheckCircle2 size={16} /> Reconnect Linear
            </>
          ) : (
            <>
              <Link size={16} /> Connect Linear
            </>
          )}
        </a>
        <Button
          type="button"
          size="lg"
          disabled={!connected}
          onClick={onContinue}
          className="rounded-none font-mono"
        >
          Continue
        </Button>
        <Button type="button" variant="ghost" onClick={onBack} className="rounded-none font-mono">
          Back
        </Button>
      </div>
    </section>
  );
}

function PermissionsStep({
  action,
  pending,
  error,
  permissions,
  onPermissionChange,
  onBack,
}: {
  action: (formData: FormData) => void;
  pending: boolean;
  error: string | null;
  permissions: ConnectorLinearPermissions;
  onPermissionChange: (scope: ConnectorLinearPermissionScope, checked: boolean) => void;
  onBack: () => void;
}) {
  return (
    <section className="mt-10">
      <p className="text-xs uppercase text-muted-foreground">03 Permissions</p>
      <h2 className="mt-4 text-xl font-bold tracking-tight text-foreground">
        Choose the Linear permissions Connector should expose.
      </h2>

      <form action={action} className="mt-8">
        <div className="grid gap-px border border-border bg-border">
          {CONNECTOR_LINEAR_PERMISSION_SCOPES.map((scope) => (
            <label
              key={scope}
              className="grid gap-4 bg-background p-5 sm:grid-cols-[auto_1fr] sm:items-center"
            >
              {permissions[scope] ? <input type="hidden" name={scope} value="on" /> : null}
              <Checkbox
                checked={permissions[scope]}
                onCheckedChange={(checked) => onPermissionChange(scope, Boolean(checked))}
              />
              <span>
                <span className="block text-sm font-bold text-foreground">
                  {CONNECTOR_LINEAR_PERMISSION_LABELS[scope]}
                </span>
                <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                  {scope === "linear.issues.read"
                    ? "Allow agents to search and inspect Linear issues."
                    : "Allow agents to create issues and update existing issues."}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
          <Lock size={14} />
          These are Connector policy settings for future enforcement.
        </div>

        {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}

        <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-border pt-8">
          <Button type="submit" size="lg" disabled={pending} className="rounded-none font-mono">
            {pending ? "Finishing..." : "Finish setup"}
          </Button>
          <Button type="button" variant="ghost" onClick={onBack} className="rounded-none font-mono">
            Back
          </Button>
        </div>
      </form>
    </section>
  );
}

function initialStep(state: ConnectorSetupState): Step {
  if (!state.organization) return 1;
  if (!state.linear.configured) return 2;
  return 3;
}

function isStepComplete(
  step: Step,
  organization: SerializedConnectorOrganization | null,
  linearConnected: boolean,
) {
  if (step === 1) return Boolean(organization);
  if (step === 2) return linearConnected;
  return false;
}

function formatConnectorTimestamp(value: string) {
  return value.slice(0, 16).replace("T", " ");
}
