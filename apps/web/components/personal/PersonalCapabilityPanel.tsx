"use client";

import {
  extractMentionIds,
  isExternalSkillReference,
  repositoryIdForFullName,
  type ResolvedSkillMetadata,
} from "@opencompany/agent-runtime";
import type { AgentConfig } from "@opencompany/agent-runtime/types";
import { Check, GitBranch, LoaderCircle, type LucideIcon, Plus, Sparkles, Wrench } from "lucide-react";
import { useState } from "react";
import { findTool } from "@/components/agent-editor/tools";
import type { PersonalIntegrationId } from "@/lib/personal/actions";

export type CapabilitySection = "skills" | "integrations" | "tools";

const SECTION_META: Record<
  CapabilitySection,
  { title: string; description: string; empty: string }
> = {
  skills: {
    title: "Skills",
    description:
      "Skill packs your agent can load on demand. Add one by @-mentioning it in Behavior; your agent can also write its own personal skills.",
    empty: "No skills yet. Mention @skill/… in Behavior, or let your agent write its own.",
  },
  integrations: {
    title: "Integrations",
    description: "External services your agent is connected to.",
    empty: "No integrations yet. Mention a GitHub repository in Behavior to connect one.",
  },
  tools: {
    title: "Tools",
    description: "Built-in tools your agent can call. Add one by @-mentioning it in Behavior.",
    empty: "No tools yet. Mention a tool like @exa in Behavior to enable it.",
  },
};

type Row = { id: string; icon: LucideIcon; label: string; description: string };
type IntegrationRow = Row & {
  badge?: string;
  badgeHref?: string;
  // Controls badge styling: "success" (green, default), "warning" (amber, used with badgeHref for
  // setup prompts), or "neutral" (muted, used to mark agent-authored personal skills).
  badgeTone?: "success" | "warning" | "neutral";
};

export type PersonalGitHubIntegrationStatus =
  | "not_connected"
  | "connected"
  | "needs_repository_access"
  | "needs_reauth"
  | "sync_failed"
  | "error";

export function PersonalCapabilityPanel({
  section,
  config,
  personalSkills,
  githubRequested,
  githubStatus,
  onAddIntegration,
}: {
  section: CapabilitySection;
  config: AgentConfig;
  personalSkills: ResolvedSkillMetadata[];
  githubRequested: boolean;
  githubStatus: PersonalGitHubIntegrationStatus;
  // Append an integration's @-mention to the agent body. Only wired for the integrations section.
  onAddIntegration?: (integration: PersonalIntegrationId) => Promise<void>;
}) {
  const meta = SECTION_META[section];
  const rows =
    section === "integrations"
      ? buildPersonalIntegrationRows(config, { githubRequested, githubStatus })
      : buildRows(section, config, personalSkills);

  return (
    <div className="mx-auto w-full max-w-[680px] px-6 py-10">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">{meta.title}</h1>
          <p className="mt-1 text-[13px] text-ink-muted">{meta.description}</p>
        </div>
        {section === "integrations" && onAddIntegration && (
          <AddIntegrationMenu githubAdded={githubRequested} onAdd={onAddIntegration} />
        )}
      </div>

      <div className="mt-6">
        {rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-surface/45 px-4 py-6 text-[13px] text-ink-muted">
            {meta.empty}
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((row) => (
              <CapabilityRow key={row.id} {...row} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const BADGE_TONE_CLASS: Record<NonNullable<IntegrationRow["badgeTone"]>, string> = {
  success: "border-success-border bg-success-bg text-success",
  warning: "border-warning-border bg-warning-bg text-warning",
  neutral: "border-border bg-surface text-ink-muted",
};

function CapabilityRow({
  icon: Icon,
  label,
  description,
  badge,
  badgeHref,
  badgeTone = "success",
}: IntegrationRow) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-surface/55 px-3.5 py-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-muted">
        <Icon size={15} strokeWidth={1.85} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-ink">{label}</div>
        <div className="mt-0.5 truncate text-[12px] leading-4 text-ink-muted">{description}</div>
      </div>
      {badge &&
        (badgeHref ? (
          <a
            href={badgeHref}
            className={`shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-opacity hover:opacity-80 ${BADGE_TONE_CLASS.warning}`}
          >
            {badge}
          </a>
        ) : (
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${BADGE_TONE_CLASS[badgeTone]}`}
          >
            {badge}
          </span>
        ))}
    </div>
  );
}

// The integrations a user can attach by hand. Each one maps to the same @-mention the agent could
// write itself, so picking it here just authors that mention in the body — the body stays the
// source of truth (see `addPersonalAgentIntegration`).
const ADDABLE_INTEGRATIONS: Array<{
  id: PersonalIntegrationId;
  icon: LucideIcon;
  label: string;
  description: string;
}> = [
  {
    id: "github",
    icon: GitBranch,
    label: "GitHub",
    description: "Use the workspace GitHub integration and its repositories.",
  },
];

// Top-right "Add" affordance for the Integrations tab. Opening it reveals the addable integrations;
// picking one appends its @-mention to the agent body. We surface the manual path here because not
// everyone thinks to @-mention in Behavior — but it writes the exact same thing, so the two paths
// never diverge.
function AddIntegrationMenu({
  githubAdded,
  onAdd,
}: {
  githubAdded: boolean;
  onAdd: (integration: PersonalIntegrationId) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<PersonalIntegrationId | null>(null);

  const isAdded = (id: PersonalIntegrationId) => id === "github" && githubAdded;

  const handleSelect = async (id: PersonalIntegrationId) => {
    if (isAdded(id) || pending) return;
    setPending(id);
    try {
      await onAdd(id);
      setOpen(false);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface/70 px-2.5 py-1.5 text-[12.5px] font-medium text-ink/90 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <Plus size={13} strokeWidth={2} />
        Add integration
      </button>
      {open && (
        <>
          {/* Click-away scrim. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-20 mt-1.5 w-[280px] overflow-hidden rounded-lg border border-border bg-canvas p-1 shadow-[0_8px_24px_rgba(15,15,15,0.12)]">
            {ADDABLE_INTEGRATIONS.map((integration) => {
              const added = isAdded(integration.id);
              const loading = pending === integration.id;
              return (
                <button
                  key={integration.id}
                  type="button"
                  disabled={added || Boolean(pending)}
                  onClick={() => handleSelect(integration.id)}
                  className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors duration-150 hover:bg-surface-hover disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-muted">
                    <integration.icon size={14} strokeWidth={1.85} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">
                      {integration.label}
                    </div>
                    <div className="mt-0.5 truncate text-[12px] leading-4 text-ink-muted">
                      {integration.description}
                    </div>
                  </div>
                  {loading ? (
                    <LoaderCircle size={13} strokeWidth={2} className="shrink-0 animate-spin text-ink-subtle" />
                  ) : added ? (
                    <Check size={14} strokeWidth={2} className="shrink-0 text-success" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export function hasPersonalGitHubIntegrationRequest(body: string) {
  return extractMentionIds(body).some((id) => id.trim().toLowerCase() === "github");
}

export function personalIntegrationCount(input: { config: AgentConfig; githubRequested: boolean }) {
  return input.config.integrations.github.repositories.length + (input.githubRequested ? 1 : 0);
}

export function buildPersonalIntegrationRows(
  config: AgentConfig,
  input: { githubRequested: boolean; githubStatus: PersonalGitHubIntegrationStatus },
): IntegrationRow[] {
  const rows: IntegrationRow[] = [];
  const needsSetup = input.githubStatus !== "connected";

  if (input.githubRequested) {
    rows.push({
      id: "github",
      icon: GitBranch,
      label: "GitHub",
      description: needsSetup
        ? "Set up GitHub in workspace settings before using repositories."
        : "Workspace GitHub integration is available.",
      badge: needsSetup ? "Requires setup" : "Connected",
      ...(needsSetup ? { badgeHref: "/settings/integrations" } : {}),
    });
  }

  rows.push(
    ...config.integrations.github.repositories.map((repository) => ({
      id: repository.binding
        ? `${repository.binding.connection.externalId}:${repository.binding.externalId}`
        : repositoryIdForFullName(repository.fullName),
      icon: GitBranch,
      label: repository.fullName,
      description: repository.binding?.connection.label
        ? `GitHub · ${repository.binding.connection.label}`
        : "GitHub repository",
    })),
  );

  return rows;
}

function buildRows(
  section: CapabilitySection,
  config: AgentConfig,
  personalSkills: ResolvedSkillMetadata[],
): IntegrationRow[] {
  if (section === "tools") {
    return config.tools.map((tool) => ({
      id: tool.id,
      icon: findTool(tool.id)?.icon ?? Wrench,
      label: tool.label,
      description: tool.description,
    }));
  }

  if (section === "skills") {
    const referenced: IntegrationRow[] = (config.skills ?? []).map((skill) => ({
      id: skill.id,
      icon: Sparkles,
      label: isExternalSkillReference(skill) ? skill.name || skill.id : skill.id,
      description: isExternalSkillReference(skill)
        ? skill.description || skill.source.url
        : `Built-in skill · ${skill.id}`,
    }));
    // Personal skills are authored by the agent itself (or the user) under agent/skills/<id>/ and
    // discovered from the bundle — not in `skills:` frontmatter — so they're flagged with a badge.
    const personal: IntegrationRow[] = personalSkills.map((skill) => ({
      id: `personal:${skill.id}`,
      icon: Sparkles,
      label: skill.name,
      description: skill.description,
      badge: skill.provenance === "user" ? "Personal · you" : "Personal",
      badgeTone: "neutral",
    }));
    return [...referenced, ...personal];
  }

  return buildPersonalIntegrationRows(config, {
    githubRequested: false,
    githubStatus: "not_connected",
  });
}
