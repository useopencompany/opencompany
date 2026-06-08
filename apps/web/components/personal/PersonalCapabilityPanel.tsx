"use client";

import {
  extractMentionIds,
  isExternalSkillReference,
  repositoryIdForFullName,
} from "@opencompany/agent-runtime";
import type { AgentConfig } from "@opencompany/agent-runtime/types";
import { GitBranch, type LucideIcon, Sparkles, Wrench } from "lucide-react";
import { findTool } from "@/components/agent-editor/tools";

export type CapabilitySection = "skills" | "integrations" | "tools";

const SECTION_META: Record<
  CapabilitySection,
  { title: string; description: string; empty: string }
> = {
  skills: {
    title: "Skills",
    description:
      "Skill packs your agent can load on demand. Add one by @-mentioning it in Behavior.",
    empty: "No skills yet. Mention @skill/… in Behavior to add one.",
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
  githubRequested,
  githubStatus,
}: {
  section: CapabilitySection;
  config: AgentConfig;
  githubRequested: boolean;
  githubStatus: PersonalGitHubIntegrationStatus;
}) {
  const meta = SECTION_META[section];
  const rows =
    section === "integrations"
      ? buildPersonalIntegrationRows(config, { githubRequested, githubStatus })
      : buildRows(section, config);

  return (
    <div className="mx-auto w-full max-w-[680px] px-6 py-10">
      <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">{meta.title}</h1>
      <p className="mt-1 text-[13px] text-ink-muted">{meta.description}</p>

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

function CapabilityRow({ icon: Icon, label, description, badge, badgeHref }: IntegrationRow) {
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
            className="shrink-0 rounded-full border border-warning-border bg-warning-bg px-2 py-0.5 text-[10.5px] font-medium text-warning transition-opacity hover:opacity-80"
          >
            {badge}
          </a>
        ) : (
          <span className="shrink-0 rounded-full border border-success-border bg-success-bg px-2 py-0.5 text-[10.5px] font-medium text-success">
            {badge}
          </span>
        ))}
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

function buildRows(section: CapabilitySection, config: AgentConfig): Row[] {
  if (section === "tools") {
    return config.tools.map((tool) => ({
      id: tool.id,
      icon: findTool(tool.id)?.icon ?? Wrench,
      label: tool.label,
      description: tool.description,
    }));
  }

  if (section === "skills") {
    return (config.skills ?? []).map((skill) => ({
      id: skill.id,
      icon: Sparkles,
      label: isExternalSkillReference(skill) ? skill.name || skill.id : skill.id,
      description: isExternalSkillReference(skill)
        ? skill.description || skill.source.url
        : `Built-in skill · ${skill.id}`,
    }));
  }

  return buildPersonalIntegrationRows(config, {
    githubRequested: false,
    githubStatus: "not_connected",
  });
}
