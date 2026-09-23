"use client";

import type {
  CompanyGitHubAvailableInstallationsDto,
  CompanyGitHubInstallationDto,
  CompanyGitHubPluginDto,
  PluginEventDefinitionDto,
} from "@opencompany/protocol";
import { Alert, AlertDescription, AlertTitle } from "@opencompany/ui/components/alert";
import { Badge } from "@opencompany/ui/components/badge";
import { Button, buttonVariants } from "@opencompany/ui/components/button";
import { toast } from "@opencompany/ui/components/sonner";
import { cn } from "@opencompany/ui/lib/utils";
import { AlertCircle, Building2, Loader2, Users, Webhook } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { IntentPrefetchLink } from "@/components/IntentPrefetchLink";
import { PageContent } from "@/components/PageContent";
import { PluginConnectionFeedback } from "@/components/PluginConnectionSettings";
import { ScopeTabs } from "@/components/ScopeControls";
import {
  type CompanyPluginActionResult,
  linkCompanyGitHubInstallationAction,
  unlinkCompanyGitHubInstallationAction,
} from "@/lib/company-plugin-actions";
import { SERVICE_MARKS } from "@/lib/service-marks";

const COMPANY_GITHUB_HREF = "/plugins/company/github";
// The same App members install for "GitHub as you"; installing or authorizing it returns here.
const GITHUB_APP_INSTALL_HREF = `/api/integrations/github-user/start?returnTo=${encodeURIComponent(COMPANY_GITHUB_HREF)}`;
const GitHubMark = SERVICE_MARKS.github;

type AvailableInstallation = NonNullable<
  CompanyGitHubAvailableInstallationsDto["installations"]
>[number];

export function PluginScopeTabs({ value }: { value: "personal" | "company" }) {
  const router = useRouter();
  return (
    <ScopeTabs
      label="Plugin scope"
      value={value}
      onChange={(scope) => router.push(scope === "company" ? "/plugins?scope=company" : "/plugins")}
    />
  );
}

export function CompanyPluginsRoute({ github }: { github: CompanyGitHubPluginDto }) {
  const connected = github.installations.filter(
    (installation: CompanyGitHubInstallationDto) => installation.status === "connected",
  );
  return (
    <PageContent title="Plugins" contentClassName="max-w-[960px]">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <PluginScopeTabs value="company" />
      </div>
      <div className="flex flex-col gap-2.5">
        <p className="px-2 text-[13px] leading-5 text-ink-subtle">
          Company plugins belong to the workspace. An admin connects them once, and everyone’s
          company agents and workflows can use them.
        </p>
        <ul className="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-2">
          <li className="group flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-2.5 transition-colors duration-150 hover:bg-surface-hover">
            <IntentPrefetchLink
              href={COMPANY_GITHUB_HREF}
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              <GitHubIcon className="size-10" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[13.5px] font-medium leading-5 text-ink">
                    GitHub
                  </span>
                  {connected.length > 0 ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-1.5 py-0.5 text-[11px] leading-none text-success">
                      <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
                      Connected
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-[12px] leading-5 text-ink-subtle">
                  Start company agents from new issues and pull requests.
                </span>
              </span>
            </IntentPrefetchLink>
            <IntentPrefetchLink
              href={COMPANY_GITHUB_HREF}
              className={cn(
                buttonVariants({
                  variant: connected.length > 0 ? "outline" : "default",
                  size: "sm",
                }),
                "h-8 rounded-full px-3 text-[12px] shadow-none",
              )}
            >
              {connected.length > 0 ? "Manage" : "Connect"}
            </IntentPrefetchLink>
          </li>
        </ul>
      </div>
    </PageContent>
  );
}

export function CompanyGitHubPluginDetail({
  plugin,
  available,
}: {
  plugin: CompanyGitHubPluginDto;
  // Null for members, who can see the linked accounts but not change them.
  available: CompanyPluginActionResult<CompanyGitHubAvailableInstallationsDto> | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const connected = plugin.installations.filter(
    (installation: CompanyGitHubInstallationDto) => installation.status === "connected",
  );
  const linkedIds = new Set(
    connected.map((installation: CompanyGitHubInstallationDto) => installation.installationId),
  );

  const run = (
    key: string,
    action: () => Promise<CompanyPluginActionResult<unknown>>,
    success: string,
  ) => {
    setPending(key);
    startTransition(async () => {
      const result = await action();
      setPending(null);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(success);
      router.refresh();
    });
  };

  return (
    <>
      <PluginConnectionFeedback />
      <PageContent
        title="GitHub"
        description="Let company agents act on what happens in your GitHub organizations."
        backLink={{ href: "/plugins?scope=company", label: "Company plugins" }}
        icon={<GitHubIcon className="size-9" />}
        badge={
          <Badge variant="outline" className="gap-1">
            <Building2 className="size-3" aria-hidden="true" />
            Company
          </Badge>
        }
      >
        {!plugin.configured ? (
          <Alert>
            <AlertCircle />
            <AlertTitle>GitHub events aren’t set up on this server</AlertTitle>
            <AlertDescription>
              Accounts can be connected, but GitHub can’t deliver events until the GitHub App’s
              webhook secret is configured.
            </AlertDescription>
          </Alert>
        ) : null}

        <Section
          id="company-github-accounts"
          icon={Users}
          title="Connected accounts"
          description="Events from these GitHub organizations can start runs in this workspace."
        >
          {connected.length === 0 ? (
            <Empty>
              {plugin.canManage
                ? "No GitHub account is connected yet."
                : "No GitHub account is connected yet. Ask a workspace admin to connect one."}
            </Empty>
          ) : (
            <ul className="overflow-hidden rounded-lg border border-border bg-surface">
              {connected.map((installation: CompanyGitHubInstallationDto) => (
                <LinkedInstallationRow
                  key={installation.integrationId}
                  installation={installation}
                  canManage={plugin.canManage}
                  pending={pending === installation.integrationId}
                  onDisconnect={() =>
                    run(
                      installation.integrationId,
                      () => unlinkCompanyGitHubInstallationAction(installation.integrationId),
                      `${installation.accountLogin} disconnected.`,
                    )
                  }
                />
              ))}
            </ul>
          )}
        </Section>

        {plugin.canManage && available ? (
          <Section
            id="company-github-connect"
            icon={Building2}
            title="Connect an account"
            description="Accounts where the opencompany GitHub App is installed and your GitHub account has access."
          >
            {!available.ok ? (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>GitHub accounts unavailable</AlertTitle>
                <AlertDescription>{available.error}</AlertDescription>
              </Alert>
            ) : available.data.installations === null ? (
              <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface p-3">
                <p className="text-[12.5px] leading-5 text-ink-subtle">
                  Sign in with GitHub first so opencompany can see which accounts you can connect.
                </p>
                <a href={GITHUB_APP_INSTALL_HREF} className={buttonVariants({ size: "sm" })}>
                  Sign in with GitHub
                </a>
              </div>
            ) : (
              <>
                <AvailableInstallations
                  installations={available.data.installations.filter(
                    (installation: AvailableInstallation) =>
                      !linkedIds.has(installation.installationId),
                  )}
                  pending={pending}
                  onConnect={(installationId, login) =>
                    run(
                      installationId,
                      () => linkCompanyGitHubInstallationAction(installationId),
                      `${login} connected.`,
                    )
                  }
                />
                <a
                  href={GITHUB_APP_INSTALL_HREF}
                  className="w-fit text-[12px] text-ink-subtle underline decoration-border underline-offset-2 hover:text-ink"
                >
                  Install the GitHub App on another account
                </a>
              </>
            )}
          </Section>
        ) : null}

        <Section
          id="company-github-events"
          icon={Webhook}
          title="Events"
          description="Choose these as triggers on a company agent or workflow, then pick a repository you can access."
        >
          <ul className="overflow-hidden rounded-lg border border-border bg-surface">
            {plugin.events.map((event: PluginEventDefinitionDto) => (
              <li key={event.id} className="border-b border-border px-3 py-2.5 last:border-b-0">
                <p className="text-[13px] font-medium text-ink">{event.label}</p>
                <p className="mt-0.5 text-[12px] leading-4 text-ink-subtle">{event.description}</p>
              </li>
            ))}
          </ul>
          <p className="text-[12px] leading-4 text-ink-subtle">
            Events opened by bots are ignored, so agents can’t trigger each other in a loop.
          </p>
        </Section>
      </PageContent>
    </>
  );
}

function LinkedInstallationRow({
  installation,
  canManage,
  pending,
  onDisconnect,
}: {
  installation: CompanyGitHubInstallationDto;
  canManage: boolean;
  pending: boolean;
  onDisconnect: () => void;
}) {
  return (
    <li className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
      <GitHubIcon className="size-8" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-ink">{installation.accountLogin}</p>
        <p className="text-[12px] leading-4 text-ink-subtle">
          {installation.accountType === "Organization" ? "Organization" : "Personal account"}
        </p>
      </div>
      {canManage ? (
        <Button variant="outline" size="sm" disabled={pending} onClick={onDisconnect}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Disconnect
        </Button>
      ) : null}
    </li>
  );
}

function AvailableInstallations({
  installations,
  pending,
  onConnect,
}: {
  installations: NonNullable<CompanyGitHubAvailableInstallationsDto["installations"]>;
  pending: string | null;
  onConnect: (installationId: string, login: string) => void;
}) {
  if (installations.length === 0) {
    return (
      <Empty>
        {"No other accounts to connect. Install the GitHub App on an organization to add it here."}
      </Empty>
    );
  }
  return (
    <ul className="overflow-hidden rounded-lg border border-border bg-surface">
      {installations.map((installation: AvailableInstallation) => (
        <li
          key={installation.installationId}
          className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
        >
          {installation.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- small remote GitHub avatar
            <img
              src={installation.avatarUrl}
              alt=""
              className="size-8 shrink-0 rounded-lg border border-border/70"
            />
          ) : (
            <GitHubIcon className="size-8" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-ink">{installation.accountLogin}</p>
            <p className="text-[12px] leading-4 text-ink-subtle">
              {installation.suspended
                ? "Suspended on GitHub"
                : installation.accountType === "Organization"
                  ? "Organization"
                  : "Personal account"}
            </p>
          </div>
          <Button
            size="sm"
            disabled={installation.suspended || pending !== null}
            onClick={() => onConnect(installation.installationId, installation.accountLogin)}
          >
            {pending === installation.installationId ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : null}
            Connect
          </Button>
        </li>
      ))}
    </ul>
  );
}

function Section({
  id,
  icon: Icon,
  title,
  description,
  children,
}: {
  id: string;
  icon: typeof Users;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
        <div>
          <h2 id={id} className="text-[13px] font-semibold leading-5 text-ink">
            {title}
          </h2>
          <p className="text-[12px] leading-4 text-ink-subtle">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: string }) {
  return (
    <p className="rounded-lg border border-border bg-surface px-3 py-3 text-[12.5px] leading-5 text-ink-subtle">
      {children}
    </p>
  );
}

function GitHubIcon({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg border border-border/70",
        GitHubMark.iconClassName,
        className,
      )}
    >
      <GitHubMark.Icon className="size-1/2" />
    </span>
  );
}
