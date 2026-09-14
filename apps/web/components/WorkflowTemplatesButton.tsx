"use client";

import { scheduleSummary } from "@opencompany/agent-runtime";
import type { WorkflowScope } from "@opencompany/protocol";
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
  Clock,
  CreditCard,
  Inbox,
  LayoutTemplate,
  ListTodo,
  Loader2,
  Rocket,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  archiveHeadlessWorkflow,
  createHeadlessWorkflow,
  updateHeadlessWorkflow,
} from "@/lib/headless-automation-commands";
import { supportedTimezones } from "@/lib/timezones";
import { DEFAULT_WORKFLOW_SCHEDULE_TIMEZONE } from "@/lib/workflow-schedule-defaults";
import {
  WORKFLOW_TEMPLATES,
  type WorkflowTemplate,
  type WorkflowTemplateIcon,
  type WorkflowTemplateMissingPlugin,
  type WorkflowTemplateOutcomePlugin,
} from "@/lib/workflow-templates";

const TEMPLATE_ICONS: Record<WorkflowTemplateIcon, LucideIcon> = {
  ship: Rocket,
  inbox: Inbox,
  revenue: CreditCard,
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
  /** Visibility the clone is created with, so a template follows the list filter like "New workflow" does. */
  scope,
}: {
  missingPlugins: Record<string, WorkflowTemplateMissingPlugin[]> | null;
  scope: WorkflowScope;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null);

  const startFromTemplate = async (template: WorkflowTemplate) => {
    if (pendingTemplateId) return;
    setPendingTemplateId(template.id);
    try {
      router.push(await createWorkflowFromTemplate(template, scope));
    } catch (cause) {
      setPendingTemplateId(null);
      toast.error(
        cause instanceof Error ? cause.message : "The template could not be used. Try again.",
      );
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" className="shadow-sm" onClick={() => setOpen(true)}>
        <LayoutTemplate size={14} strokeWidth={2} />
        Workflow templates
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          // A clone is two API calls; closing mid-flight would hide the spinner on a draft that is
          // still being created and then navigate out from under the list.
          if (!next && pendingTemplateId) return;
          setOpen(next);
        }}
      >
        <DialogContent className="max-h-[calc(100vh-4rem)] max-w-[560px] gap-5 overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[15px]">Workflow templates</DialogTitle>
            <DialogDescription className="text-[12.5px] leading-5 text-ink-subtle">
              Each one opens as a draft you can edit. Nothing runs until you activate it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2.5">
            {WORKFLOW_TEMPLATES.map((template) => (
              <WorkflowTemplateCard
                key={template.id}
                template={template}
                missingPlugins={missingPlugins?.[template.id] ?? []}
                pending={pendingTemplateId === template.id}
                disabled={pendingTemplateId !== null && pendingTemplateId !== template.id}
                onUse={() => void startFromTemplate(template)}
              />
            ))}
          </div>
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
            <Clock size={13} strokeWidth={1.8} className="text-ink-faint" />
            {/* Wall-clock only: the clone binds the schedule to the owner's own timezone. */}
            {scheduleSummary({ cron: template.schedule.cron, timezone: "UTC" })}
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
            <span key={missing.plugin}>
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

// Creation is two calls because the API creates an empty draft and fills it on update. A failure
// between them would leave a nameless empty workflow in the list, so the draft is archived before
// the error surfaces.
async function createWorkflowFromTemplate(template: WorkflowTemplate, scope: WorkflowScope) {
  const schedule = {
    type: "schedule" as const,
    cron: template.schedule.cron,
    timezone: localTimezone(),
    prompt: template.schedule.prompt,
    enabled: true,
  };
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
          model: "",
          instructions: template.step.instructions,
        },
      ],
      // Drafts never fire their schedule, so the trigger can be prefilled and left switched on: the
      // workflow starts running when the owner reviews the instructions and activates it.
      status: "draft",
      trigger: schedule,
      triggers: [{ id: `trigger-${globalThis.crypto.randomUUID()}`, ...schedule }],
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
