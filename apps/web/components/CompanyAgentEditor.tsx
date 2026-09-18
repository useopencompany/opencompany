"use client";

import type {
  CompanyAgentDto,
  SkillCatalogItemDto,
  SlackBotWorkspaceSettingsDto,
} from "@opencompany/protocol";
import { Button, buttonVariants } from "@opencompany/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import { toast } from "@opencompany/ui/components/sonner";
import { Switch } from "@opencompany/ui/components/switch";
import { Check, ChevronDown, History, Loader2, Play, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { StatusDot } from "@/components/StatusDot";
import {
  SectionLabel,
  SlackAvatarField,
  StepCard,
  TriggerSection,
  type WorkflowStep,
  type WorkflowTriggerDraft,
  workflowTriggerInput,
} from "@/components/WorkflowEditor";
import type { WorkflowStepPatch } from "@/components/WorkflowModelControls";
import {
  archiveCompanyAgent,
  runCompanyAgentNow,
  updateCompanyAgent,
  uploadCompanyAgentPhoto,
} from "@/lib/company-agent-commands";
import type { WorkflowEventProviderOption } from "@/lib/workflow-event-triggers";

const AUTOSAVE_DELAY_MS = 1200;

type AgentDraft = {
  name: string;
  description: string;
  instructions: string;
  photoUrl: string;
  model: string;
  runtimeModel?: string;
  reasoningEffort?: string;
  status: CompanyAgentDto["status"];
  slackEnabled: boolean;
  triggers: WorkflowTriggerDraft[];
};

type SaveState = "saved" | "saving" | "error";

/**
 * One agent: who it is, what it is responsible for, when it wakes up, and where it reports.
 *
 * Only the owner can change any of it. Everyone else gets the same page read-only plus Run now,
 * because a teammate should be able to use an agent and see exactly what it is configured to do
 * without being able to redirect someone else's connected accounts.
 */
export function CompanyAgentEditor({
  agent,
  canEdit,
  ownerName,
  skillCatalog,
  eventProviders,
  slackBotSettings,
}: {
  agent: CompanyAgentDto;
  canEdit: boolean;
  ownerName: string;
  skillCatalog: SkillCatalogItemDto[];
  eventProviders: WorkflowEventProviderOption[];
  slackBotSettings: SlackBotWorkspaceSettingsDto;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<AgentDraft>(() => agentDraft(agent));
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isRunning, startRunning] = useTransition();
  const [isArchiving, startArchiving] = useTransition();
  const draftRef = useRef(draft);
  const versionRef = useRef(agent.version);
  const savedRef = useRef(JSON.stringify(draft));
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const saveLatest = useCallback(async () => {
    const snapshot = draftRef.current;
    const value = JSON.stringify(snapshot);
    if (value === savedRef.current) return;
    setSaveState("saving");
    setSaveError(null);
    try {
      const saved = await updateCompanyAgent(agent.id, {
        expectedVersion: versionRef.current,
        name: snapshot.name.trim() || "Untitled agent",
        description: snapshot.description,
        instructions: snapshot.instructions,
        photoUrl: snapshot.photoUrl,
        model: snapshot.model,
        ...(snapshot.runtimeModel ? { runtimeModel: snapshot.runtimeModel } : {}),
        ...(snapshot.reasoningEffort ? { reasoningEffort: snapshot.reasoningEffort } : {}),
        status: snapshot.status,
        slackEnabled: snapshot.slackEnabled,
        triggers: snapshot.triggers.map(workflowTriggerInput),
      });
      versionRef.current = saved.version;
      savedRef.current = value;
      setSaveState("saved");
    } catch (error) {
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : "This agent could not be saved.");
    }
  }, [agent.id]);

  // Saves are serialized. Each one sends the version the previous one returned, so two overlapping
  // autosaves cannot race a stale `expectedVersion` into a conflict — or, worse, land out of order
  // and leave the cached version pointing at the older write. Awaiting this also lets Run now wait
  // for the editor to be fully persisted before it compiles the agent.
  const save = useCallback(() => {
    const next = saveQueueRef.current.then(saveLatest);
    saveQueueRef.current = next.catch(() => undefined);
    return next;
  }, [saveLatest]);

  useEffect(() => {
    if (!canEdit) return;
    const timer = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [canEdit, draft, save]);

  const activationBlockedReason = draft.instructions.trim()
    ? null
    : "Write what this agent is responsible for before activating it.";
  const runBlockedReason = !agent.ownerActive
    ? "This agent has no active owner, so it has no connections to work with."
    : !draft.instructions.trim()
      ? "Write what this agent is responsible for before running it."
      : null;

  const runNow = () => {
    if (isRunning || runBlockedReason) return;
    startRunning(async () => {
      try {
        // Save first: a run compiles the agent as it is stored, not as the page shows it.
        await save();
        const created = await runCompanyAgentNow(agent.id);
        toast.success(`Started ${created.task.displayId}.`);
        router.push(`/agents/${encodeURIComponent(agent.slug)}/runs`);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "This agent could not be run.");
      }
    });
  };

  const deleteAgent = () => {
    if (isArchiving) return;
    startArchiving(async () => {
      try {
        await archiveCompanyAgent(agent.id, { expectedVersion: versionRef.current });
        toast.success(`Deleted “${agent.name}”.`);
        router.push("/agents");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "This agent could not be deleted.");
      }
    });
  };

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[760px] flex-col gap-8 pb-24 pt-10 sm:pt-12">
          <Link
            href="/agents"
            prefetch
            className="inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            Company agents
          </Link>

          <header className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                {canEdit ? (
                  <input
                    value={draft.name}
                    maxLength={64}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    placeholder="PR Reviewer"
                    aria-label="Agent name"
                    className="-mx-1 w-full rounded-md bg-transparent px-1 text-[28px] font-semibold leading-tight tracking-tight text-ink outline-none placeholder:text-ink-faint"
                  />
                ) : (
                  <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-ink">
                    {draft.name.trim() || "Untitled agent"}
                  </h1>
                )}
                {canEdit ? (
                  <input
                    value={draft.description}
                    maxLength={1024}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                    placeholder="What this agent is responsible for..."
                    aria-label="Agent summary"
                    className="-mx-1 w-full rounded-md bg-transparent px-1 text-[14.5px] leading-6 text-ink-subtle outline-none placeholder:text-ink-faint"
                  />
                ) : draft.description.trim() ? (
                  <p className="text-[14.5px] leading-6 text-ink-subtle">{draft.description}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <AgentStatusPicker
                  value={draft.status}
                  disabled={!canEdit}
                  activationBlockedReason={activationBlockedReason}
                  onChange={(status) => setDraft({ ...draft, status })}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isRunning || runBlockedReason !== null}
                  title={runBlockedReason ?? undefined}
                  onClick={runNow}
                >
                  {isRunning ? <Loader2 className="animate-spin" /> : <Play size={13} />}
                  Run now
                </Button>
                <Link
                  href={`/agents/${encodeURIComponent(agent.slug)}/runs`}
                  prefetch
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                >
                  <History size={13} />
                  See runs
                </Link>
              </div>
            </div>
            <OwnerNotice ownerName={ownerName} ownerActive={agent.ownerActive} canEdit={canEdit} />
            {saveState === "error" && saveError ? (
              <p role="alert" className="text-[12.5px] leading-5 text-danger">
                {saveError}
              </p>
            ) : saveState === "saving" ? (
              <p className="text-[12.5px] leading-5 text-ink-subtle">Saving…</p>
            ) : null}
          </header>

          <section className="flex flex-col gap-3">
            <SectionLabel>Identity</SectionLabel>
            <div className="rounded-xl border border-border bg-surface px-3.5 py-3.5">
              <SlackAvatarField
                workflowId={agent.id}
                avatarUrl={draft.photoUrl}
                canEdit={canEdit}
                upload={({ workflowId, file }) =>
                  uploadCompanyAgentPhoto({ agentId: workflowId, file })
                }
                onChange={(photoUrl) => setDraft({ ...draft, photoUrl })}
                hint="Used in the app and as this agent's photo on its Slack posts. PNG, JPEG, or WebP up to 1 MB."
              />
            </div>
          </section>

          <StepCard
            index={0}
            step={agentStep(agent.id, draft)}
            canEdit={canEdit}
            skillCatalog={skillCatalog}
            onChange={(patch) => setDraft((current) => agentDraftWithPatch(current, patch))}
          />

          <TriggerSection
            triggers={draft.triggers}
            canEdit={canEdit}
            eventProviders={eventProviders}
            emptyLabel="This agent only works when someone runs it. Add a trigger to wake it up on its own."
            onChange={(triggers) => setDraft({ ...draft, triggers })}
          />

          <section className="flex flex-col gap-3">
            <SectionLabel>Slack</SectionLabel>
            <div className="flex items-start gap-3 rounded-xl border border-border bg-surface px-3.5 py-3.5">
              <Switch
                checked={draft.slackEnabled}
                disabled={!canEdit}
                aria-label="Post to Slack"
                onCheckedChange={(slackEnabled) => setDraft({ ...draft, slackEnabled })}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="text-[13px] font-medium text-ink">Post to Slack</p>
                <p className="text-[12px] leading-5 text-ink-subtle">
                  {slackBotSettings.connected
                    ? `Posts go out through the workspace bot as “${draft.name.trim() || "Untitled agent"}” with this agent's photo. Say in the instructions which channel to post in and whom to notify. A reply in the thread continues that run.`
                    : "Connect the Slack bot in workspace settings before this agent can post."}
                </p>
              </div>
            </div>
          </section>

          {canEdit ? (
            <section className="flex flex-col gap-3">
              <SectionLabel>Danger zone</SectionLabel>
              <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-3.5 py-3">
                <p className="text-[12.5px] leading-5 text-ink-subtle">
                  Deleting stops this agent’s triggers and removes it from the list. Its finished
                  runs stay in the workspace, but this run history goes with it. Pause instead if
                  you only want it to stop working.
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={isArchiving}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={13} />
                  Delete
                </Button>
              </div>
            </section>
          ) : null}
        </div>
      </div>

      <Dialog
        open={confirmDelete}
        onOpenChange={(open) => {
          if (!open && !isArchiving) setConfirmDelete(false);
        }}
      >
        <DialogContent className="max-w-[420px] gap-5">
          <DialogHeader>
            <DialogTitle className="text-[15px]">Delete agent?</DialogTitle>
            <DialogDescription className="text-[12.5px] leading-5 text-ink-subtle">
              “{agent.name}” will stop running and leave the list. Its finished runs stay in the
              workspace and keep their own links, but this run history goes with the agent.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              disabled={isArchiving}
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
            <Button variant="destructive" size="sm" disabled={isArchiving} onClick={deleteAgent}>
              {isArchiving ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Delete agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

// The one thing a reader has to understand about a company agent: whose access it is using.
function OwnerNotice({
  ownerName,
  ownerActive,
  canEdit,
}: {
  ownerName: string;
  ownerActive: boolean;
  canEdit: boolean;
}) {
  if (!ownerActive) {
    return (
      <p
        role="alert"
        className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[12.5px] leading-5 text-danger"
      >
        This agent’s owner is no longer in the workspace. Its connections left with them, so it
        cannot run until someone recreates it.
      </p>
    );
  }
  return (
    <p className="rounded-lg border border-border-subtle bg-surface-muted px-3 py-2 text-[12.5px] leading-5 text-ink-subtle">
      {canEdit
        ? "You own this agent. Every run — yours, a teammate’s, a schedule, or an event — uses your connected accounts."
        : `${ownerName} owns this agent. You can run it and read its history; every run uses ${ownerName}’s connected accounts, not yours. Only ${ownerName} can change it.`}
    </p>
  );
}

function AgentStatusPicker({
  value,
  disabled,
  activationBlockedReason,
  onChange,
}: {
  value: CompanyAgentDto["status"];
  disabled: boolean;
  activationBlockedReason: string | null;
  onChange: (value: CompanyAgentDto["status"]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger
        type="button"
        disabled={disabled}
        aria-label={`Status: ${value === "active" ? "Active" : "Paused"}`}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-default disabled:hover:bg-surface data-[popup-open]:bg-surface-hover"
      >
        <StatusDot status={value === "active" ? "active" : "draft"} />
        {value === "active" ? "Active" : "Paused"}
        {disabled ? null : <ChevronDown size={12} strokeWidth={2} className="text-ink-subtle" />}
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-[220px] bg-surface p-1 text-ink">
        {(["active", "paused"] as const).map((option) => (
          <button
            key={option}
            type="button"
            disabled={option === "active" && activationBlockedReason !== null}
            title={option === "active" ? (activationBlockedReason ?? undefined) : undefined}
            onClick={() => {
              onChange(option);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink transition-colors duration-150 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <StatusDot status={option === "active" ? "active" : "draft"} />
            <span className="flex-1">{option === "active" ? "Active" : "Paused"}</span>
            {value === option ? <Check size={13} strokeWidth={2} className="text-ink" /> : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

// A step patch may clear the cloud-runtime fields by setting them to undefined. Under
// `exactOptionalPropertyTypes` that has to be an explicit delete rather than a spread.
function agentDraftWithPatch(current: AgentDraft, patch: WorkflowStepPatch): AgentDraft {
  const next: AgentDraft = { ...current };
  if (patch.instructions !== undefined) next.instructions = patch.instructions;
  if (patch.model !== undefined) next.model = patch.model;
  if ("runtimeModel" in patch) {
    if (patch.runtimeModel === undefined) delete next.runtimeModel;
    else next.runtimeModel = patch.runtimeModel;
  }
  if ("reasoningEffort" in patch) {
    if (patch.reasoningEffort === undefined) delete next.reasoningEffort;
    else next.reasoningEffort = patch.reasoningEffort;
  }
  return next;
}

function agentDraft(agent: CompanyAgentDto): AgentDraft {
  return {
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    photoUrl: agent.photoUrl,
    model: agent.model,
    ...(agent.runtimeModel ? { runtimeModel: agent.runtimeModel } : {}),
    ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
    status: agent.status,
    slackEnabled: agent.slackEnabled,
    triggers: (agent.triggers as WorkflowTriggerDraft[]).map((trigger) =>
      trigger.type === "schedule"
        ? {
            id: trigger.id,
            type: "schedule",
            cron: trigger.cron,
            timezone: trigger.timezone,
            prompt: trigger.prompt,
            enabled: trigger.enabled,
          }
        : { ...trigger },
    ),
  };
}

// An agent has one standing instruction, which the shared editor renders as a single step.
function agentStep(agentId: string, draft: AgentDraft): WorkflowStep {
  return {
    id: `${agentId}-instructions`,
    title: "",
    model: draft.model,
    ...(draft.runtimeModel ? { runtimeModel: draft.runtimeModel } : {}),
    ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
    instructions: draft.instructions,
  };
}
