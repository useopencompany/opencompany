"use client";

import { scheduleSummary } from "@opencompany/agent-runtime";
import type {
  CompanyGitHubPluginDto,
  CompanySentryPluginDto,
  WorkflowScope,
} from "@opencompany/protocol";
import { Button } from "@opencompany/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { toast } from "@opencompany/ui/components/sonner";
import {
  GitHubIcon,
  GmailIcon,
  type LucideIcon,
  SlackIcon,
  StripeIcon,
} from "@opencompany/ui/icons";
import {
  ArrowRight,
  ChevronLeft,
  Clock,
  CreditCard,
  Inbox,
  LayoutTemplate,
  ListTodo,
  Loader2,
  MessageSquareCode,
  Rocket,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  archiveHeadlessWorkflow,
  createHeadlessWorkflow,
  updateHeadlessWorkflow,
} from "@/lib/headless-automation-commands";
import type { sentryTemplateDefinition } from "@/lib/sentry-template-setup";
import { supportedTimezones } from "@/lib/timezones";
import {
  loadWorkflowEventFilterOptions,
  type WorkflowEventFilterOption,
} from "@/lib/workflow-event-filters";
import { companyGitHubEventAccounts } from "@/lib/workflow-event-triggers";
import { DEFAULT_WORKFLOW_SCHEDULE_TIMEZONE } from "@/lib/workflow-schedule-defaults";
import {
  WORKFLOW_TEMPLATES,
  type WorkflowTemplate,
  type WorkflowTemplateIcon,
  type WorkflowTemplateMissingPlugin,
  type WorkflowTemplateOutcomePlugin,
} from "@/lib/workflow-templates";
import { SentryTemplateSetup } from "./SentryTemplateSetup";

const TEMPLATE_ICONS: Record<WorkflowTemplateIcon, LucideIcon> = {
  ship: Rocket,
  inbox: Inbox,
  revenue: CreditCard,
  review: MessageSquareCode,
};

// An event trigger needs a repository before it can be saved, so its clone is a two-step flow: pick
// the account and repository, then create the draft already bound to them.
type EventTemplateSetup = {
  template: WorkflowTemplate;
  trigger: Extract<WorkflowTemplate["trigger"], { kind: "event" }>;
  accounts: { integrationId: string; label: string }[];
};

const OUTCOME_ICONS: Record<WorkflowTemplateOutcomePlugin, LucideIcon> = {
  github: GitHubIcon,
  gmail: GmailIcon,
  slack: SlackIcon,
  stripe: StripeIcon,
};

export function WorkflowTemplatesButton({
  /**
   * Required plugins each template is still missing, keyed by template id. `null` when the plugin or
   * account snapshot could not be loaded, which drops the setup hints rather than guessing at them.
   */
  missingPlugins,
  /** The company GitHub connection an event template's trigger binds to, when one is linked. */
  companyGitHub,
  companySentry,
  /** Visibility the clone is created with, so a template follows the list filter like "New workflow" does. */
  scope,
}: {
  missingPlugins: Record<string, WorkflowTemplateMissingPlugin[]> | null;
  companyGitHub?: CompanyGitHubPluginDto | null;
  companySentry?: CompanySentryPluginDto | null;
  scope: WorkflowScope;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null);
  const [setup, setSetup] = useState<EventTemplateSetup | null>(null);
  const companyAccounts = companyGitHubEventAccounts(companyGitHub);
  const [sentrySetup, setSentrySetup] = useState<WorkflowTemplate | null>(null);

  const startFromTemplate = async (
    template: WorkflowTemplate,
    trigger?: WorkflowTriggerInput,
    definition?: ReturnType<typeof sentryTemplateDefinition>,
  ) => {
    if (pendingTemplateId) return;
    setPendingTemplateId(template.id);
    try {
      router.push(
        await createWorkflowFromTemplate(
          template,
          scope,
          trigger ?? scheduleTrigger(template),
          definition,
        ),
      );
    } catch (cause) {
      setPendingTemplateId(null);
      toast.error(
        cause instanceof Error ? cause.message : "The template could not be used. Try again.",
      );
    }
  };

  // An event template cannot be cloned straight from the card: its trigger needs an account and a
  // repository first, so it opens a setup step instead of a draft.
  const openTemplate = (template: WorkflowTemplate) => {
    if (template.setup?.startsWith("sentry")) {
      setSentrySetup(template);
      return;
    }
    if (template.trigger.kind === "schedule") {
      void startFromTemplate(template);
      return;
    }
    setSetup({ template, trigger: template.trigger, accounts: companyAccounts });
  };

  return (
    <>
      <Button variant="outline" size="sm" className="shadow-sm" onClick={() => setOpen(true)}>
        <LayoutTemplate size={14} strokeWidth={2} />
        Workflow templates
      </Button>

      {/* Closing mid-clone is allowed: the draft is already committed server-side and the push to it
          still runs, so blocking dismissal would only risk trapping the user behind the modal. */}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Reopening the gallery should show the gallery, not the setup step it was closed on.
          if (!next) {
            setSetup(null);
            setSentrySetup(null);
          }
        }}
      >
        <DialogContent className="max-h-[calc(100vh-4rem)] max-w-[560px] gap-5 overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[15px]">
              {sentrySetup?.name ?? (setup ? setup.template.name : "Workflow templates")}
            </DialogTitle>
            <DialogDescription className="text-[12.5px] leading-5 text-ink-subtle">
              {setup || sentrySetup
                ? "Choose what this workflow watches. It opens as a draft you can edit."
                : "Each one opens as a draft you can edit. Nothing runs until you activate it."}
            </DialogDescription>
          </DialogHeader>
          {sentrySetup ? (
            <SentryTemplateSetup
              template={sentrySetup}
              plugin={companySentry ?? null}
              pending={pendingTemplateId === sentrySetup.id}
              onBack={() => setSentrySetup(null)}
              onUse={(definition) =>
                void startFromTemplate(
                  sentrySetup,
                  definition.triggers[0] as WorkflowTriggerInput,
                  definition,
                )
              }
            />
          ) : setup ? (
            <EventTemplateSetupStep
              setup={setup}
              pending={pendingTemplateId === setup.template.id}
              onBack={() => setSetup(null)}
              onUse={(trigger) => void startFromTemplate(setup.template, trigger)}
            />
          ) : (
            <div className="grid gap-2.5">
              {WORKFLOW_TEMPLATES.map((template) => (
                <WorkflowTemplateCard
                  key={template.id}
                  template={template}
                  missingPlugins={missingPlugins?.[template.id] ?? []}
                  pending={pendingTemplateId === template.id}
                  // Without a connected account an event template has nothing to bind its trigger
                  // to, so the card stays inert and its setup hint says what to connect first.
                  disabled={
                    (pendingTemplateId !== null && pendingTemplateId !== template.id) ||
                    (template.setup?.startsWith("sentry")
                      ? companySentry?.connection?.status !== "connected" ||
                        !companySentry.connection.verifiedAt
                      : template.trigger.kind === "event" && companyAccounts.length === 0)
                  }
                  onUse={() => openTemplate(template)}
                />
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function WorkflowTemplateCard({
  template,
  missingPlugins,
  pending,
  disabled,
  onUse,
}: {
  template: WorkflowTemplate;
  missingPlugins: WorkflowTemplateMissingPlugin[];
  pending: boolean;
  disabled: boolean;
  onUse: () => void;
}) {
  const Icon = TEMPLATE_ICONS[template.icon];
  // No outcome plugin means the run's own Task is where the result lands.
  const OutcomeIcon = template.outcome.plugin ? OUTCOME_ICONS[template.outcome.plugin] : ListTodo;

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface">
      <button
        type="button"
        onClick={onUse}
        disabled={pending || disabled}
        aria-busy={pending}
        className="flex flex-1 flex-col gap-3 p-4 text-left transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-muted text-ink-subtle">
            {pending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Icon size={15} strokeWidth={1.8} />
            )}
          </span>
          <span className="flex min-w-0 flex-col gap-1">
            <span className="text-[13.5px] font-medium leading-tight text-ink">
              {template.name}
            </span>
            <span className="text-[12.5px] leading-5 text-ink-subtle">{template.description}</span>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-subtle">
          <span className="inline-flex items-center gap-1.5">
            {template.trigger.kind === "schedule" ? (
              <>
                <Clock size={13} strokeWidth={1.8} className="text-ink-faint" />
                {/* Wall-clock only: the clone binds the schedule to the owner's own timezone. */}
                {scheduleSummary({ cron: template.trigger.cron, timezone: "UTC" })}
              </>
            ) : (
              <>
                <Zap size={13} strokeWidth={1.8} className="text-ink-faint" />
                {template.trigger.label}
              </>
            )}
          </span>
          <ArrowRight size={12} strokeWidth={1.8} className="text-ink-faint" />
          <span className="inline-flex items-center gap-1.5">
            <OutcomeIcon size={13} strokeWidth={1.8} />
            {template.outcome.label}
          </span>
        </div>
      </button>
      {missingPlugins.length > 0 ? (
        <p className="border-t border-border-subtle px-4 py-2.5 text-[11.5px] leading-5 text-ink-subtle">
          Needs{" "}
          {missingPlugins.map((missing, index) => (
            <span key={missing.setupHref}>
              {index > 0 ? (index === missingPlugins.length - 1 ? " and " : ", ") : null}
              <Link
                href={missing.setupHref}
                className="font-medium text-ink underline underline-offset-2 hover:text-ink-subtle"
              >
                {missing.label}
              </Link>
            </span>
          ))}{" "}
          before it can run.
        </p>
      ) : null}
    </div>
  );
}

// The account and repository an event template's trigger binds to, chosen before the clone. The
// repository list comes from the trigger author's own GitHub access, the same read the editor makes.
function EventTemplateSetupStep({
  setup,
  pending,
  onBack,
  onUse,
}: {
  setup: EventTemplateSetup;
  pending: boolean;
  onBack: () => void;
  onUse: (trigger: WorkflowTriggerInput) => void;
}) {
  const [integrationId, setIntegrationId] = useState(setup.accounts[0]!.integrationId);
  // Both the list and the choice are stamped with the account they belong to, so switching accounts
  // drops the previous repositories without an effect that resets them.
  const [loaded, setLoaded] = useState<{ integrationId: string; result: RepositoryList } | null>(
    null,
  );
  const [chosen, setChosen] = useState<{
    integrationId: string;
    repository: WorkflowEventFilterOption;
  } | null>(null);
  const repositories = loaded?.integrationId === integrationId ? loaded.result : null;
  const repository = chosen?.integrationId === integrationId ? chosen.repository : null;

  useEffect(() => {
    let cancelled = false;
    void loadWorkflowEventFilterOptions({
      provider: setup.trigger.provider,
      resourceType: "repository",
      integrationId,
      event: setup.trigger.event,
    })
      .then((result) => {
        if (cancelled) return;
        setLoaded({
          integrationId,
          result: result.ok ? { ok: true, options: result.options } : result,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setLoaded({
          integrationId,
          result: { ok: false, error: "Could not load repositories. Try again." },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [integrationId, setup.trigger.event, setup.trigger.provider]);

  return (
    <div className="flex flex-col gap-4">
      {setup.accounts.length > 1 ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink-subtle">GitHub account</span>
          <select
            aria-label="GitHub account"
            value={integrationId}
            onChange={(changed) => setIntegrationId(changed.target.value)}
            className="h-8 rounded-lg border border-border bg-canvas px-2.5 text-[12.5px] text-ink outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            {setup.accounts.map((account) => (
              <option key={account.integrationId} value={account.integrationId}>
                {account.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-ink-subtle">Repository</span>
        <select
          aria-label="Repository"
          value={repository?.id ?? ""}
          disabled={!repositories?.ok}
          onChange={(changed) => {
            const next = (repositories?.ok ? repositories.options : []).find(
              (option) => option.id === changed.target.value,
            );
            setChosen(next ? { integrationId, repository: next } : null);
          }}
          className="h-8 rounded-lg border border-border bg-canvas px-2.5 text-[12.5px] text-ink outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-70"
        >
          <option value="">
            {repositories === null ? "Loading repositories…" : "Select a repository…"}
          </option>
          {(repositories?.ok ? repositories.options : []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
        {repositories && !repositories.ok ? (
          <span className="text-[11.5px] text-warning">{repositories.error}</span>
        ) : null}
        {repositories?.ok && repositories.options.length === 0 ? (
          <span className="text-[11.5px] text-warning">
            No repositories on this account are visible to your GitHub login.
          </span>
        ) : null}
      </label>
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={pending}>
          <ChevronLeft size={14} strokeWidth={2} />
          All templates
        </Button>
        <Button
          size="sm"
          disabled={!repository || pending}
          aria-busy={pending}
          onClick={() => {
            if (!repository) return;
            onUse({
              type: "event",
              provider: setup.trigger.provider,
              event: setup.trigger.event,
              integrationId,
              filters: { repository: { id: repository.id, name: repository.name } },
              prompt: setup.trigger.prompt,
            });
          }}
        >
          {pending ? <Loader2 size={14} className="animate-spin" /> : null}
          Use template
        </Button>
      </div>
    </div>
  );
}

type RepositoryList =
  | { ok: true; options: WorkflowEventFilterOption[] }
  | { ok: false; error: string };

type WorkflowTriggerInput =
  | { type: "schedule"; cron: string; timezone: string; prompt: string; enabled: true }
  | {
      type: "event";
      provider: string;
      event: string;
      integrationId: string;
      filters: Record<
        string,
        { id: string; name: string; pairs?: { key: string; value: string }[] }
      >;
      prompt: string;
    };

function scheduleTrigger(template: WorkflowTemplate): WorkflowTriggerInput {
  if (template.trigger.kind !== "schedule") {
    throw new Error("This template needs a trigger to be chosen before it can be used.");
  }
  return {
    type: "schedule",
    cron: template.trigger.cron,
    timezone: localTimezone(),
    prompt: template.trigger.prompt,
    enabled: true,
  };
}

// Creation is two calls because the API creates an empty draft and fills it on update. A failure
// between them would leave a nameless empty workflow in the list, so the draft is archived before
// the error surfaces.
async function createWorkflowFromTemplate(
  template: WorkflowTemplate,
  scope: WorkflowScope,
  trigger: WorkflowTriggerInput,
  definition?: ReturnType<typeof sentryTemplateDefinition>,
) {
  const workflow = await createHeadlessWorkflow({
    name: template.name,
    description: template.description,
    scope,
  });
  try {
    await updateHeadlessWorkflow(workflow.id, {
      expectedVersion: workflow.version,
      name: template.name,
      description: template.description,
      steps: [
        {
          // The create call already minted a step id; reusing it keeps the draft to a single step.
          id: workflow.steps[0]?.id ?? globalThis.crypto.randomUUID(),
          title: template.step.title,
          model: definition?.step.model ?? template.step.model ?? "",
          ...((definition?.step.runtimeModel ?? template.step.runtimeModel)
            ? { runtimeModel: definition?.step.runtimeModel ?? template.step.runtimeModel }
            : {}),
          ...((definition?.step.reasoningEffort ?? template.step.reasoningEffort)
            ? { reasoningEffort: definition?.step.reasoningEffort ?? template.step.reasoningEffort }
            : {}),
          instructions: definition?.step.instructions ?? template.step.instructions,
        },
      ],
      // A draft never fires, so the trigger can be prefilled and left switched on: the workflow
      // starts running when the owner reviews the instructions and activates it.
      status: "draft",
      trigger,
      triggers: (definition?.triggers ?? [trigger]).map((item) => ({
        id: `trigger-${globalThis.crypto.randomUUID()}`,
        ...item,
      })) as never,
    });
  } catch (cause) {
    await archiveHeadlessWorkflow(workflow.id, { expectedVersion: workflow.version }).catch(
      (archiveError: unknown) => {
        console.error(
          "[opencompany] Failed to clean up a half-created template draft",
          archiveError,
        );
      },
    );
    throw cause;
  }
  return `/workflows/${encodeURIComponent(workflow.slug)}`;
}

// A template's "Friday at 16:00" should mean the owner's Friday afternoon, not UTC's.
function localTimezone() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone && supportedTimezones().includes(timezone)
    ? timezone
    : DEFAULT_WORKFLOW_SCHEDULE_TIMEZONE;
}
