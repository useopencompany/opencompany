"use client";

import {
  extractMentionIds,
  isExternalSkillReference,
  type ResolvedSkillMetadata,
  repositoryIdForFullName,
} from "@opencompany/agent-runtime";
import type { AgentConfig } from "@opencompany/agent-runtime/types";
import {
  Check,
  GitBranch,
  LoaderCircle,
  type LucideIcon,
  Plus,
  Search,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { findTool } from "@/components/agent-editor/tools";
import {
  ONBOARDING_CONNECTED_MESSAGE,
  type OnboardingConnectedMessage,
} from "@/lib/onboarding/setups";
import type { PersonalIntegrationId } from "@/lib/personal/actions";
import {
  PERSONAL_INTEGRATION_TOOL_IDS,
  PERSONAL_INTEGRATIONS_CATALOG,
  type PersonalIntegrationCatalogEntry,
  type PersonalIntegrationConnections,
  personalIntegrationConnectUrl,
} from "@/lib/personal/integrations-catalog";

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
    description: "Services your agent can use — first-party connections and MCP servers.",
    empty: "No integrations yet. Add one to connect a service your agent can use.",
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
  // When set, the badge renders as a "Connect" button that opens this integration's OAuth flow in a
  // popup window (rather than navigating the tab away). Takes precedence over badgeTone styling.
  connectEntry?: PersonalIntegrationCatalogEntry;
  // Controls badge styling: "success" (green, default), "warning" (amber, used for setup prompts),
  // or "neutral" (muted, used to mark agent-authored personal skills).
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
  connections,
  onAddIntegration,
}: {
  section: CapabilitySection;
  config: AgentConfig;
  personalSkills: ResolvedSkillMetadata[];
  githubRequested: boolean;
  githubStatus: PersonalGitHubIntegrationStatus;
  // Workspace-level connection state per integration (Connected vs Connect). Integrations only.
  connections?: PersonalIntegrationConnections;
  // Append an integration's @-mention to the agent body. Only wired for the integrations section.
  onAddIntegration?: (integration: PersonalIntegrationId) => Promise<void>;
}) {
  const meta = SECTION_META[section];
  const rows =
    section === "integrations"
      ? buildPersonalIntegrationRows(config, { githubRequested, githubStatus, connections })
      : buildRows(section, config, personalSkills);

  const { connectingId, openConnectPopup } = useConnectPopup();

  return (
    <div className="mx-auto w-full max-w-[680px] px-6 py-10">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">{meta.title}</h1>
          <p className="mt-1 text-[13px] text-ink-muted">{meta.description}</p>
        </div>
        {section === "integrations" && onAddIntegration && (
          <AddIntegrationButton
            config={config}
            githubRequested={githubRequested}
            connections={connections}
            onAdd={onAddIntegration}
          />
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
              <CapabilityRow
                key={row.id}
                {...row}
                onConnect={row.connectEntry ? () => openConnectPopup(row.connectEntry!) : undefined}
                connecting={Boolean(row.connectEntry && connectingId === row.connectEntry.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Opens an integration's OAuth flow in a popup window and reports back when it lands on the
// popup-closer page (/onboarding/connected, which postMessages the opener and closes itself). On a
// successful connection we router.refresh() so the server re-derives connection state and the row
// flips to "Connected" — without the integrations tab ever navigating away. Mirrors the inline
// connect flow on /onboarding/personal (see PersonalOnboardingChat).
function useConnectPopup() {
  const router = useRouter();
  const [connectingId, setConnectingId] = useState<PersonalIntegrationId | null>(null);
  const connectingRef = useRef<PersonalIntegrationId | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as OnboardingConnectedMessage | undefined;
      if (!data || data.type !== ONBOARDING_CONNECTED_MESSAGE) return;
      setConnectingId(null);
      connectingRef.current = null;
      if (data.status === "connected") router.refresh();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [router]);

  const openConnectPopup = (entry: PersonalIntegrationCatalogEntry) => {
    const width = 520;
    const height = 720;
    const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
    const popup = window.open(
      personalIntegrationConnectUrl(entry),
      "oc-personal-connect",
      `width=${width},height=${height},left=${left},top=${top}`,
    );
    if (!popup) return;
    setConnectingId(entry.id);
    connectingRef.current = entry.id;
    // If the user closes the popup without finishing, clear the pending state so the row resets.
    const timer = window.setInterval(() => {
      if (popup.closed) {
        window.clearInterval(timer);
        if (connectingRef.current === entry.id) {
          setConnectingId(null);
          connectingRef.current = null;
        }
      }
    }, 500);
  };

  return { connectingId, openConnectPopup };
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
  badgeTone = "success",
  onConnect,
  connecting,
}: IntegrationRow & { onConnect?: (() => void) | undefined; connecting?: boolean | undefined }) {
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
        (onConnect ? (
          <button
            type="button"
            onClick={onConnect}
            disabled={connecting}
            className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-opacity hover:opacity-80 disabled:opacity-70 ${BADGE_TONE_CLASS.warning}`}
          >
            {connecting && <LoaderCircle size={10} strokeWidth={2} className="animate-spin" />}
            {connecting ? "Connecting…" : badge}
          </button>
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

// Whether an integration is already attached to the agent — GitHub via its `@github` mention,
// everything else via the corresponding tool in the derived config. Mirrors the runtime derivation
// so "Added" in the picker matches what the body actually says.
function isIntegrationAdded(
  id: PersonalIntegrationId,
  config: AgentConfig,
  githubRequested: boolean,
) {
  if (id === "github") return githubRequested;
  return config.tools.some((tool) => tool.id === id);
}

// Top-right "Add integration" affordance for the Integrations tab. Opens a searchable modal of every
// supported integration; picking one appends its @-mention to the agent body. We surface the manual
// path here because not everyone thinks to @-mention in Behavior — but it writes the exact same
// thing, so the two paths never diverge (see `addPersonalAgentIntegration`).
function AddIntegrationButton({
  config,
  githubRequested,
  connections,
  onAdd,
}: {
  config: AgentConfig;
  githubRequested: boolean;
  connections?: PersonalIntegrationConnections | undefined;
  onAdd: (integration: PersonalIntegrationId) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="shrink-0">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface/70 px-2.5 py-1.5 text-[12.5px] font-medium text-ink/90 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <Plus size={13} strokeWidth={2} />
        Add integration
      </button>
      {open && (
        <AddIntegrationModal
          config={config}
          githubRequested={githubRequested}
          connections={connections}
          onAdd={onAdd}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// Searchable modal listing every supported integration. Mirrors the AddSkillDialog pattern
// (fixed overlay, Escape/click-away close, autofocused search). Selecting a not-yet-added
// integration appends its @-mention and closes; the row then shows in the list with its connect
// affordance.
function AddIntegrationModal({
  config,
  githubRequested,
  connections,
  onAdd,
  onClose,
}: {
  config: AgentConfig;
  githubRequested: boolean;
  connections?: PersonalIntegrationConnections | undefined;
  onAdd: (integration: PersonalIntegrationId) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<PersonalIntegrationId | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [pending, onClose]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return PERSONAL_INTEGRATIONS_CATALOG;
    return PERSONAL_INTEGRATIONS_CATALOG.filter(
      (entry) =>
        entry.label.toLowerCase().includes(needle) ||
        entry.description.toLowerCase().includes(needle) ||
        entry.id.toLowerCase().includes(needle),
    );
  }, [query]);

  const handleSelect = async (entry: PersonalIntegrationCatalogEntry) => {
    if (pending) return;
    if (isIntegrationAdded(entry.id, config, githubRequested)) return;
    setPending(entry.id);
    try {
      await onAdd(entry.id);
      onClose();
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/35 px-4 py-[12vh]"
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-integration-title"
        className="flex max-h-[calc(100vh-24vh)] w-full max-w-[460px] flex-col overflow-hidden rounded-lg border border-black/[0.1] bg-surface-raised shadow-[0_24px_64px_rgba(0,0,0,0.22),0_4px_14px_rgba(0,0,0,0.12)]"
      >
        <div className="border-b border-black/[0.08] px-3 py-2.5">
          <h2 id="add-integration-title" className="sr-only">
            Add integration
          </h2>
          <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-surface px-2.5">
            <Search size={14} strokeWidth={1.9} className="shrink-0 text-ink-subtle" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search integrations…"
              className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-subtle/70"
            />
          </div>
        </div>

        <div className="overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <div className="px-2.5 py-6 text-center text-[12.5px] text-ink-muted">
              No integrations match “{query.trim()}”.
            </div>
          ) : (
            results.map((entry) => {
              const added = isIntegrationAdded(entry.id, config, githubRequested);
              const connected = Boolean(connections?.[entry.id]);
              const loading = pending === entry.id;
              return (
                <button
                  key={entry.id}
                  type="button"
                  disabled={added || Boolean(pending)}
                  onClick={() => handleSelect(entry)}
                  className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors duration-150 hover:bg-surface-hover disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-muted">
                    <entry.icon size={14} strokeWidth={1.85} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-ink">
                        {entry.label}
                      </span>
                      {connected && (
                        <span className="shrink-0 rounded-full border border-success-border bg-success-bg px-1.5 py-px text-[10px] font-medium text-success">
                          Connected
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-[12px] leading-4 text-ink-muted">
                      {entry.description}
                    </div>
                  </div>
                  {loading ? (
                    <LoaderCircle
                      size={13}
                      strokeWidth={2}
                      className="shrink-0 animate-spin text-ink-subtle"
                    />
                  ) : added ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-ink-subtle">
                      <Check size={13} strokeWidth={2} className="text-success" />
                      Added
                    </span>
                  ) : (
                    <Plus size={14} strokeWidth={2} className="shrink-0 text-ink-subtle" />
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export function hasPersonalGitHubIntegrationRequest(body: string) {
  return extractMentionIds(body).some((id) => id.trim().toLowerCase() === "github");
}

// Count every integration attached to the agent: the @github request, each connected repository,
// and each non-GitHub integration tool (Gmail/Calendar/Linear/Slack/PostHog). Drives the sidebar
// badge.
export function personalIntegrationCount(input: { config: AgentConfig; githubRequested: boolean }) {
  const toolIntegrations = input.config.tools.filter((tool) =>
    PERSONAL_INTEGRATION_TOOL_IDS.has(tool.id),
  ).length;
  return (
    input.config.integrations.github.repositories.length +
    (input.githubRequested ? 1 : 0) +
    toolIntegrations
  );
}

// One row per integration attached to the agent. GitHub keeps its `@github` summary row plus a row
// per connected repository; the other integrations each render a row when their tool is enabled.
// Each row shows a Connected badge or a "Connect" badge linking to the in-tab OAuth flow.
export function buildPersonalIntegrationRows(
  config: AgentConfig,
  input: {
    githubRequested: boolean;
    githubStatus: PersonalGitHubIntegrationStatus;
    connections?: PersonalIntegrationConnections | undefined;
  },
): IntegrationRow[] {
  const rows: IntegrationRow[] = [];

  for (const entry of PERSONAL_INTEGRATIONS_CATALOG) {
    if (entry.id === "github") {
      if (!input.githubRequested) continue;
      rows.push({
        id: "github",
        icon: entry.icon,
        label: entry.label,
        ...githubRowStatus(input.githubStatus, entry),
      });
      continue;
    }

    if (!config.tools.some((tool) => tool.id === entry.id)) continue;
    const connected = Boolean(input.connections?.[entry.id]);
    rows.push({
      id: entry.id,
      icon: entry.icon,
      label: entry.label,
      description: entry.description,
      ...(connected
        ? { badge: "Connected", badgeTone: "success" as const }
        : { badge: "Connect", connectEntry: entry }),
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

// Description + badge for the `@github` summary row, derived from the workspace connection status.
// Not-connected states open the GitHub connect flow in a popup.
function githubRowStatus(
  status: PersonalGitHubIntegrationStatus,
  entry: PersonalIntegrationCatalogEntry,
): Pick<IntegrationRow, "description" | "badge" | "connectEntry" | "badgeTone"> {
  if (status === "connected") {
    return {
      description: "Workspace GitHub integration is available.",
      badge: "Connected",
      badgeTone: "success",
    };
  }
  const description =
    status === "needs_repository_access"
      ? "Connected — choose repositories to use in workspace settings."
      : "Connect GitHub before your agent can use repositories.";
  return { description, badge: "Connect", connectEntry: entry };
}

function buildRows(
  section: CapabilitySection,
  config: AgentConfig,
  personalSkills: ResolvedSkillMetadata[],
): IntegrationRow[] {
  if (section === "tools") {
    // Integration-backed tools (Gmail/Calendar/Linear/Slack/PostHog) live under Integrations, so
    // they're excluded here to avoid showing each integration in two tabs.
    return config.tools
      .filter((tool) => !PERSONAL_INTEGRATION_TOOL_IDS.has(tool.id))
      .map((tool) => ({
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
