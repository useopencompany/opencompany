"use client";

import {
  extractMentionIds,
  isExternalSkillReference,
  type ResolvedSkillMetadata,
  repositoryIdForFullName,
} from "@opencompany/agent-runtime";
import type { AgentConfig, AgentToolId } from "@opencompany/agent-runtime/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  GitBranch,
  LoaderCircle,
  type LucideIcon,
  Plus,
  Search,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { type AddedSkill, AddSkillDialog } from "@/components/agent-editor/AddSkillDialog";
import { mergeSkillCatalog } from "@/components/agent-editor/skillCatalog";
import {
  ADD_SKILL_MENTION_ID,
  AGENT_TOOLS,
  type AgentSkillCatalogEntry,
  type AgentSkillMention,
  type AgentTool,
  buildSkillMentionItems,
  findTool,
} from "@/components/agent-editor/tools";
import { ToolPolicyEditor } from "@/components/ToolPolicyEditor";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import {
  disconnectGitHubIntegrationAction,
  refreshGitHubRepositories,
} from "@/lib/integrations/actions";
import { disconnectGoogleIntegrationAction } from "@/lib/integrations/google-actions";
import {
  removeBetterStackMcpConnection,
  removeBraintrustMcpConnection,
  removeLinearMcpToken,
  removePostHogMcpConnection,
  removeSlackMcpConnection,
} from "@/lib/mcp/actions";
import {
  ONBOARDING_CONNECTED_MESSAGE,
  type OnboardingConnectedMessage,
} from "@/lib/onboarding/setups";
import type { PersonalIntegrationId } from "@/lib/personal/actions";
import type {
  PersonalIntegrationAccountDetail,
  PersonalIntegrationDetail,
  PersonalIntegrationDetails,
} from "@/lib/personal/integration-details";
import {
  PERSONAL_INTEGRATION_TOOL_IDS,
  PERSONAL_INTEGRATIONS_CATALOG,
  type PersonalIntegrationCatalogEntry,
  type PersonalIntegrationConnections,
  personalIntegrationConnectUrl,
} from "@/lib/personal/integrations-catalog";
import { fetchWorkspaceSkills } from "@/lib/skills/client";
import type { WorkspaceToolPolicyOverrides } from "@/lib/tool-policies/data";

export type CapabilitySection = "skills" | "integrations" | "tools";

const SECTION_META: Record<
  CapabilitySection,
  { title: string; description: string; empty: string }
> = {
  skills: {
    title: "Skills",
    description:
      "Skill packs your agent can load on demand. Add one here or mention it in Behavior.",
    empty:
      "No skills yet. Add one here, mention @skill/… in Behavior, or let your agent write its own.",
  },
  integrations: {
    title: "Integrations",
    description: "Services your agent can use — first-party connections and MCP servers.",
    empty: "No integrations yet. Add one to connect a service your agent can use.",
  },
  tools: {
    title: "Tools",
    description: "Built-in tools your agent can call. Add one here or mention it in Behavior.",
    empty: "No tools yet. Add one here or mention a tool like @exa in Behavior.",
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
  // Rich connection detail (accounts, repositories/calendars, MCP endpoint) rendered in the row's
  // expandable section. Integration rows only.
  detail?: PersonalIntegrationDetail;
  // What the integration grants the agent — shown as an access summary when connected, and as a
  // "connecting grants…" preview before. Integration rows only.
  permissions?: string[];
  // Whether the integration is connected at the workspace level; switches the permissions heading.
  connected?: boolean;
  // The catalog id behind this row, used to route the expanded section's disconnect/refresh
  // actions. Integration rows only — repository rows manage nothing.
  integrationId?: PersonalIntegrationId;
  policyProviderKey?: string;
  policyOverrides?: WorkspaceToolPolicyOverrides[string] | undefined;
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
  details,
  toolPolicies,
  onAddIntegration,
  onAddTool,
  onAddSkill,
}: {
  section: CapabilitySection;
  config: AgentConfig;
  personalSkills: ResolvedSkillMetadata[];
  githubRequested: boolean;
  githubStatus: PersonalGitHubIntegrationStatus;
  // Workspace-level connection state per integration (Connected vs Connect). Integrations only.
  connections?: PersonalIntegrationConnections;
  // Per-integration accounts/resources detail for the expandable rows. Integrations only.
  details?: PersonalIntegrationDetails;
  toolPolicies?: WorkspaceToolPolicyOverrides;
  // Append an integration's @-mention to the agent body. Only wired for the integrations section.
  onAddIntegration?: (integration: PersonalIntegrationId) => Promise<boolean>;
  onAddTool?: (toolId: AgentToolId) => Promise<void>;
  onAddSkill?: (skillId: string) => Promise<void>;
}) {
  const meta = SECTION_META[section];
  const rows =
    section === "integrations"
      ? buildPersonalIntegrationRows(config, {
          githubRequested,
          githubStatus,
          connections,
          details,
          toolPolicies,
        })
      : buildRows(section, config, personalSkills);

  const { connectingId, connectError, openConnectPopup } = useConnectPopup();

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
            onConnect={openConnectPopup}
            onAdd={onAddIntegration}
          />
        )}
        {section === "tools" && onAddTool && <AddToolButton config={config} onAdd={onAddTool} />}
        {section === "skills" && onAddSkill && (
          <AddSkillButton config={config} onAdd={onAddSkill} />
        )}
      </div>

      <div className="mt-6">
        {connectError && (
          <div className="mb-3 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-[12.5px] leading-5 text-danger">
            {connectError}
          </div>
        )}
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
  const [connectError, setConnectError] = useState<string | null>(null);
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
    setConnectError(null);
    if (!popup) {
      setConnectError(
        `We couldn't open the ${entry.label} connect window. Allow pop-ups for this site, then try again.`,
      );
      return false;
    }
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
    return true;
  };

  return { connectingId, connectError, openConnectPopup };
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
  detail,
  permissions,
  connected,
  integrationId,
  onConnect,
  connecting,
  policyProviderKey,
  policyOverrides,
}: IntegrationRow & { onConnect?: (() => void) | undefined; connecting?: boolean | undefined }) {
  const [expanded, setExpanded] = useState(false);
  // Integration rows with connection detail or a permissions summary expand inline; plain rows
  // (tools, skills, agent-attached repositories) keep the flat layout.
  const expandable = Boolean(
    (detail && (detail.accounts.length > 0 || detail.statusReason)) ||
      permissions?.length ||
      policyProviderKey,
  );

  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface/55">
      {/* Row click is a convenience; the chevron button below is the keyboard/AT path. */}
      <div
        className={`flex min-w-0 items-center gap-3 px-3.5 py-3 ${expandable ? "cursor-pointer select-none" : ""}`}
        onClick={expandable ? () => setExpanded((value) => !value) : undefined}
      >
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
              onClick={(event) => {
                event.stopPropagation();
                onConnect();
              }}
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
        {expandable && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse ${label} details` : `Expand ${label} details`}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((value) => !value);
            }}
            className="shrink-0 rounded p-0.5 text-ink-subtle transition-colors hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <ChevronRight
              size={14}
              strokeWidth={2}
              className={`transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
            />
          </button>
        )}
      </div>
      {expanded && expandable && (
        <IntegrationRowDetail
          detail={detail}
          permissions={permissions}
          connected={connected}
          integrationId={integrationId}
          integrationLabel={label}
          policyProviderKey={policyProviderKey}
          policyOverrides={policyOverrides}
        />
      )}
    </div>
  );
}

// The expanded body of an integration row: who is connected (accounts), what the connection can
// reach (repositories/calendars), connection health, what the integration lets the agent do, and
// the management actions (refresh, disconnect). Rendered only after the user expands the row, so
// the relative timestamps never run during SSR.
function IntegrationRowDetail({
  detail,
  permissions,
  connected,
  integrationId,
  integrationLabel,
  policyProviderKey,
  policyOverrides,
}: {
  detail?: PersonalIntegrationDetail | undefined;
  permissions?: string[] | undefined;
  connected?: boolean | undefined;
  integrationId?: PersonalIntegrationId | undefined;
  integrationLabel: string;
  policyProviderKey?: string | undefined;
  policyOverrides?: WorkspaceToolPolicyOverrides[string] | undefined;
}) {
  // Captured once when the section is expanded — keeps render pure (same pattern as PersonalInbox).
  const [now] = useState(() => Date.now());
  return (
    <div className="space-y-3 border-t border-border/70 px-3.5 py-3">
      {detail?.statusReason && <p className="text-[12px] text-warning">{detail.statusReason}</p>}

      {detail?.accounts.map((account) => (
        <IntegrationAccountDetail
          key={account.id}
          account={account}
          resourcesLabel={detail.resourcesLabel}
          now={now}
          integrationId={integrationId}
          integrationLabel={integrationLabel}
        />
      ))}

      {permissions && permissions.length > 0 && (
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
            {connected ? "What your agent can do" : "Connecting grants your agent"}
          </div>
          <ul className="mt-1.5 space-y-1">
            {permissions.map((permission) => (
              <li key={permission} className="flex items-start gap-1.5 text-[12px] text-ink-muted">
                <Check size={12} strokeWidth={2} className="mt-0.5 shrink-0 text-success" />
                <span>{permission}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* MCP connections have no per-account section, so their disconnect action lives here. */}
      {connected && integrationId && detail?.accounts.length === 0 && (
        <IntegrationDetailActions
          integrationId={integrationId}
          integrationLabel={integrationLabel}
        />
      )}
      {connected && policyProviderKey ? (
        <ToolPolicyEditor providerKey={policyProviderKey} overrides={policyOverrides} />
      ) : null}
    </div>
  );
}

// One connected account inside an expanded integration row — "@login · Organization" or the
// Google account email — plus its resource list (repositories, calendars), any health warning,
// and the account's management actions.
function IntegrationAccountDetail({
  account,
  resourcesLabel,
  now,
  integrationId,
  integrationLabel,
}: {
  account: PersonalIntegrationAccountDetail;
  resourcesLabel: string | null;
  now: number;
  integrationId?: PersonalIntegrationId | undefined;
  integrationLabel: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0 truncate text-[12.5px] text-ink">
          <span className="font-medium">{account.label}</span>
          {account.detail && <span className="text-ink-muted"> · {account.detail}</span>}
        </div>
        {account.updatedAt && (
          <span className="shrink-0 text-[11px] text-ink-subtle">
            synced {relativeTime(account.updatedAt, now)}
          </span>
        )}
      </div>
      {account.status !== "connected" && (
        <p className="mt-1 text-[11.5px] text-warning">
          {account.statusReason ?? "Connection needs attention — reconnect to restore access."}
        </p>
      )}
      {resourcesLabel && account.resources.length > 0 && (
        <div className="mt-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
            {resourcesLabel} · {account.resources.length}
          </div>
          <div className="mt-1 max-h-56 space-y-px overflow-y-auto">
            {account.resources.map((resource) => (
              <div
                key={resource.id}
                className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-[12px] hover:bg-surface-hover"
              >
                <span className="truncate text-ink">{resource.name}</span>
                {resource.warning ? (
                  <span
                    className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium ${BADGE_TONE_CLASS.warning}`}
                  >
                    {resource.warning}
                  </span>
                ) : (
                  resource.detail && (
                    <span className="shrink-0 text-[11px] text-ink-subtle">{resource.detail}</span>
                  )
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {integrationId && (
        <IntegrationDetailActions
          integrationId={integrationId}
          integrationLabel={integrationLabel}
          accountId={account.id}
          accountLabel={account.label}
        />
      )}
    </div>
  );
}

// Disconnect actions per integration. GitHub/Google disconnect a specific connection (account);
// MCP integrations remove the workspace credential. All of these re-derive server state via
// router.refresh() on success, same as the connect flow.
const MCP_DISCONNECT_ACTIONS: Partial<
  Record<PersonalIntegrationId, () => Promise<{ ok: boolean }>>
> = {
  linear: removeLinearMcpToken,
  slack: removeSlackMcpConnection,
  posthog: removePostHogMcpConnection,
  betterstack: removeBetterStackMcpConnection,
  braintrust: removeBraintrustMcpConnection,
};

async function disconnectIntegration(
  integrationId: PersonalIntegrationId,
  accountId?: string,
): Promise<{ ok: boolean; message?: string }> {
  if (integrationId === "github") {
    if (!accountId) return { ok: false, message: "Missing connection id." };
    return disconnectGitHubIntegrationAction(accountId);
  }
  if (integrationId === "gmail" || integrationId === "google_calendar") {
    if (!accountId) return { ok: false, message: "Missing connection id." };
    return disconnectGoogleIntegrationAction({ provider: integrationId, integrationId: accountId });
  }
  const remove = MCP_DISCONNECT_ACTIONS[integrationId];
  if (!remove) return { ok: false, message: "This integration cannot be disconnected here." };
  return remove();
}

// The management footer of an expanded integration/account section: refresh (GitHub only) and a
// two-step disconnect ("Disconnect" → "Confirm disconnect") so one stray click can't drop a
// working connection. Errors render inline next to the action that failed.
function IntegrationDetailActions({
  integrationId,
  integrationLabel,
  accountId,
  accountLabel,
}: {
  integrationId: PersonalIntegrationId;
  integrationLabel: string;
  accountId?: string | undefined;
  accountLabel?: string | undefined;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"refresh" | "disconnect" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An unconfirmed disconnect resets after a beat so the danger state never lingers.
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const run = async (
    kind: "refresh" | "disconnect",
    action: () => Promise<{ ok: boolean; message?: string }>,
  ) => {
    if (pending) return;
    setPending(kind);
    setError(null);
    try {
      const result = await action();
      if (result.ok) {
        router.refresh();
      } else {
        setError(result.message ?? "Something went wrong. Try again.");
      }
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setPending(null);
      setConfirming(false);
    }
  };

  const handleDisconnect = () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    void run("disconnect", () => disconnectIntegration(integrationId, accountId));
  };

  const disconnectTarget = accountLabel
    ? `${accountLabel} from ${integrationLabel}`
    : integrationLabel;

  return (
    <div className="mt-2.5">
      <div className="flex items-center gap-3">
        {integrationId === "github" && accountId && (
          <button
            type="button"
            disabled={Boolean(pending)}
            onClick={() =>
              void run("refresh", async () => {
                await refreshGitHubRepositories(accountId);
                return { ok: true };
              })
            }
            className="inline-flex items-center gap-1 text-[11.5px] font-medium text-ink-muted transition-colors hover:text-ink disabled:opacity-60"
          >
            {pending === "refresh" && (
              <LoaderCircle size={11} strokeWidth={2} className="animate-spin" />
            )}
            {pending === "refresh" ? "Refreshing…" : "Refresh repositories"}
          </button>
        )}
        <button
          type="button"
          disabled={Boolean(pending)}
          onClick={handleDisconnect}
          className={`inline-flex items-center gap-1 text-[11.5px] font-medium transition-colors disabled:opacity-60 ${
            confirming
              ? "rounded border border-danger-border bg-danger-bg px-1.5 py-px text-danger"
              : "text-danger/75 hover:text-danger"
          }`}
        >
          {pending === "disconnect" && (
            <LoaderCircle size={11} strokeWidth={2} className="animate-spin" />
          )}
          {pending === "disconnect"
            ? "Disconnecting…"
            : confirming
              ? "Confirm disconnect"
              : "Disconnect"}
        </button>
      </div>
      {confirming && !pending && (
        <p className="mt-1.5 text-[11.5px] leading-4 text-danger">
          Disconnect {disconnectTarget} for this workspace? Agents using it will lose access.
        </p>
      )}
      {error && <p className="mt-1.5 text-[11.5px] text-danger">{error}</p>}
    </div>
  );
}

function relativeTime(iso: string, now: number): string {
  const diff = now - Date.parse(iso);
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return day === 1 ? "1d ago" : `${day}d ago`;
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
  onConnect,
  onAdd,
}: {
  config: AgentConfig;
  githubRequested: boolean;
  connections?: PersonalIntegrationConnections | undefined;
  onConnect: (entry: PersonalIntegrationCatalogEntry) => boolean;
  onAdd: (integration: PersonalIntegrationId) => Promise<boolean>;
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
          onConnect={onConnect}
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
  onConnect,
  onAdd,
  onClose,
}: {
  config: AgentConfig;
  githubRequested: boolean;
  connections?: PersonalIntegrationConnections | undefined;
  onConnect: (entry: PersonalIntegrationCatalogEntry) => boolean;
  onAdd: (integration: PersonalIntegrationId) => Promise<boolean>;
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
    const connected = Boolean(connections?.[entry.id]);
    setPending(entry.id);
    try {
      const added = await onAdd(entry.id);
      if (!added) return;
      if (!connected && !onConnect(entry)) {
        onClose();
        return;
      }
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

function AddToolButton({
  config,
  onAdd,
}: {
  config: AgentConfig;
  onAdd: (toolId: AgentToolId) => Promise<void>;
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
        Add tool
      </button>
      {open && <AddToolModal config={config} onAdd={onAdd} onClose={() => setOpen(false)} />}
    </div>
  );
}

function AddToolModal({
  config,
  onAdd,
  onClose,
}: {
  config: AgentConfig;
  onAdd: (toolId: AgentToolId) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<AgentToolId | null>(null);
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

  const tools = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return AGENT_TOOLS.filter((tool) => !PERSONAL_INTEGRATION_TOOL_IDS.has(tool.id)).filter(
      (tool) =>
        !needle ||
        tool.label.toLowerCase().includes(needle) ||
        tool.description.toLowerCase().includes(needle) ||
        tool.id.toLowerCase().includes(needle),
    );
  }, [query]);

  const handleSelect = async (tool: AgentTool) => {
    if (pending || isToolAdded(tool.id, config)) return;
    setPending(tool.id);
    try {
      await onAdd(tool.id);
      onClose();
    } finally {
      setPending(null);
    }
  };

  return (
    <CapabilityPickerModal
      title="Add tool"
      searchPlaceholder="Search tools…"
      query={query}
      onQueryChange={setQuery}
      inputRef={inputRef}
      onClose={onClose}
      pending={Boolean(pending)}
      emptyMessage={query.trim() ? `No tools match "${query.trim()}".` : "No tools available."}
    >
      {tools.map((tool) => {
        const added = isToolAdded(tool.id, config);
        const loading = pending === tool.id;
        return (
          <CapabilityPickerRow
            key={tool.id}
            icon={tool.icon}
            label={tool.displayLabel}
            description={tool.description}
            added={added}
            loading={loading}
            disabled={added || Boolean(pending)}
            onClick={() => handleSelect(tool)}
          />
        );
      })}
    </CapabilityPickerModal>
  );
}

function AddSkillButton({
  config,
  onAdd,
}: {
  config: AgentConfig;
  onAdd: (skillId: string) => Promise<void>;
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
        Add skill
      </button>
      {open && <AddSkillModal config={config} onAdd={onAdd} onClose={() => setOpen(false)} />}
    </div>
  );
}

function AddSkillModal({
  config,
  onAdd,
  onClose,
}: {
  config: AgentConfig;
  onAdd: (skillId: string) => Promise<void>;
  onClose: () => void;
}) {
  const { workspaceId } = useWorkspaceContext();
  const queryClient = useQueryClient();
  const { data: workspaceSkills } = useQuery({
    queryKey: ["workspace-skills", workspaceId],
    queryFn: fetchWorkspaceSkills,
  });
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [showAddSkillDialog, setShowAddSkillDialog] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending && !showAddSkillDialog) onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [pending, showAddSkillDialog, onClose]);

  const skills = useMemo(() => {
    const catalog = mergeSkillCatalog(config.skills ?? [], workspaceSkills ?? []);
    const items = buildSkillMentionItems(catalog);
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (skill) =>
        skill.displayLabel.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle) ||
        skill.label.toLowerCase().includes(needle),
    );
  }, [config.skills, workspaceSkills, query]);

  const handleSelect = async (skill: AgentSkillMention) => {
    if (skill.id === ADD_SKILL_MENTION_ID) {
      setShowAddSkillDialog(true);
      return;
    }

    const skillId = skillIdFromMentionItem(skill);
    if (!skillId || pending || isSkillAdded(skillId, config)) return;
    setPending(skillId);
    try {
      await onAdd(skillId);
      onClose();
    } finally {
      setPending(null);
    }
  };

  const handleAddedSkill = (skill: AddedSkill) => {
    setShowAddSkillDialog(false);
    queryClient.setQueryData<AgentSkillCatalogEntry[]>(
      ["workspace-skills", workspaceId],
      (skills = []) => {
        if (skills.some((existing) => existing.id === skill.id)) return skills;
        return [
          ...skills,
          {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            source: skill.source,
          },
        ];
      },
    );
    queryClient.invalidateQueries({ queryKey: ["workspace-skills", workspaceId] });
    setPending(skill.id);
    void onAdd(skill.id).finally(() => {
      setPending(null);
      onClose();
    });
  };

  return (
    <>
      <CapabilityPickerModal
        title="Add skill"
        searchPlaceholder="Search skills…"
        query={query}
        onQueryChange={setQuery}
        inputRef={inputRef}
        onClose={onClose}
        pending={Boolean(pending) || showAddSkillDialog}
        emptyMessage={query.trim() ? `No skills match "${query.trim()}".` : "No skills available."}
      >
        {skills.map((skill) => {
          const addUrl = skill.id === ADD_SKILL_MENTION_ID;
          const skillId = skillIdFromMentionItem(skill);
          const added = Boolean(skillId && isSkillAdded(skillId, config));
          const loading = Boolean(skillId && pending === skillId);
          return (
            <CapabilityPickerRow
              key={skill.id}
              icon={skill.icon}
              label={skill.displayLabel}
              description={skill.description}
              added={added}
              loading={loading}
              disabled={addUrl ? Boolean(pending) : added || Boolean(pending)}
              onClick={() => handleSelect(skill)}
            />
          );
        })}
      </CapabilityPickerModal>
      {showAddSkillDialog ? (
        <AddSkillDialog onClose={() => setShowAddSkillDialog(false)} onAdded={handleAddedSkill} />
      ) : null}
    </>
  );
}

function CapabilityPickerModal({
  title,
  searchPlaceholder,
  query,
  onQueryChange,
  inputRef,
  onClose,
  pending,
  emptyMessage,
  children,
}: {
  title: string;
  searchPlaceholder: string;
  query: string;
  onQueryChange: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  pending: boolean;
  emptyMessage: string;
  children: ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
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
        aria-label={title}
        className="flex max-h-[calc(100vh-24vh)] w-full max-w-[460px] flex-col overflow-hidden rounded-lg border border-black/[0.1] bg-surface-raised shadow-[0_24px_64px_rgba(0,0,0,0.22),0_4px_14px_rgba(0,0,0,0.12)]"
      >
        <div className="border-b border-black/[0.08] px-3 py-2.5">
          <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-surface px-2.5">
            <Search size={14} strokeWidth={1.9} className="shrink-0 text-ink-subtle" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={searchPlaceholder}
              className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-subtle/70"
            />
          </div>
        </div>

        <div className="overflow-y-auto p-1.5">
          {hasChildren ? (
            children
          ) : (
            <div className="px-2.5 py-6 text-center text-[12.5px] text-ink-muted">
              {emptyMessage}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CapabilityPickerRow({
  icon: Icon,
  label,
  description,
  added,
  loading,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  description: string;
  added: boolean;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors duration-150 hover:bg-surface-hover disabled:cursor-default disabled:hover:bg-transparent"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-muted">
        <Icon size={14} strokeWidth={1.85} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-ink">{label}</div>
        <div className="mt-0.5 truncate text-[12px] leading-4 text-ink-muted">{description}</div>
      </div>
      {loading ? (
        <LoaderCircle size={13} strokeWidth={2} className="shrink-0 animate-spin text-ink-subtle" />
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
// Each row shows a Connected badge or a "Connect" badge linking to the in-tab OAuth flow, and
// carries the connection detail + permissions that power the row's expandable section.
export function buildPersonalIntegrationRows(
  config: AgentConfig,
  input: {
    githubRequested: boolean;
    githubStatus: PersonalGitHubIntegrationStatus;
    connections?: PersonalIntegrationConnections | undefined;
    details?: PersonalIntegrationDetails | undefined;
    toolPolicies?: WorkspaceToolPolicyOverrides | undefined;
  },
): IntegrationRow[] {
  const rows: IntegrationRow[] = [];

  for (const entry of PERSONAL_INTEGRATIONS_CATALOG) {
    if (entry.id === "github") {
      if (!input.githubRequested) continue;
      const detail = input.details?.github;
      rows.push({
        id: "github",
        icon: entry.icon,
        label: entry.label,
        ...githubRowStatus(input.githubStatus, entry, detail),
        ...(detail ? { detail } : {}),
        permissions: entry.permissions,
        connected: input.githubStatus === "connected",
        integrationId: entry.id,
        ...(input.githubStatus === "connected" ? { policyProviderKey: "github" } : {}),
        policyOverrides: input.toolPolicies?.github,
      });
      continue;
    }

    if (!config.tools.some((tool) => tool.id === entry.id)) continue;
    const connected = Boolean(input.connections?.[entry.id]);
    const detail = input.details?.[entry.id];
    rows.push({
      id: entry.id,
      icon: entry.icon,
      label: entry.label,
      description: (connected && detail?.summary) || entry.description,
      ...(detail ? { detail } : {}),
      permissions: entry.permissions,
      connected,
      integrationId: entry.id,
      ...(connected ? { policyProviderKey: entry.id } : {}),
      policyOverrides: input.toolPolicies?.[entry.id],
      ...(connected
        ? { badge: "Connected", badgeTone: "success" as const }
        : { badge: "Connect", connectEntry: entry }),
    });
  }

  // Repositories available through the workspace GitHub connection, keyed by full name, so the
  // agent's repository rows can flag degraded access.
  const githubResources = new Map(
    (input.details?.github?.accounts ?? []).flatMap((account) =>
      account.resources.map((resource) => [resource.name, resource] as const),
    ),
  );

  rows.push(
    ...config.integrations.github.repositories.map((repository) => {
      const resource = githubResources.get(repository.fullName);
      return {
        id: repository.binding
          ? `${repository.binding.connection.externalId}:${repository.binding.externalId}`
          : repositoryIdForFullName(repository.fullName),
        icon: GitBranch,
        label: repository.fullName,
        description: repository.binding?.connection.label
          ? `GitHub · ${repository.binding.connection.label}`
          : "GitHub repository",
        ...(resource?.warning ? { badge: resource.warning, badgeTone: "warning" as const } : {}),
      };
    }),
  );

  return rows;
}

// Description + badge for the `@github` summary row, derived from the workspace connection status.
// When connected, prefers the live connection summary ("Connected as @acme · 12 repositories").
// Not-connected states open the GitHub connect flow in a popup.
function githubRowStatus(
  status: PersonalGitHubIntegrationStatus,
  entry: PersonalIntegrationCatalogEntry,
  detail: PersonalIntegrationDetail | undefined,
): Pick<IntegrationRow, "description" | "badge" | "connectEntry" | "badgeTone"> {
  if (status === "connected") {
    return {
      description:
        detail?.summary ??
        "Your agent can use any repository the GitHub connection can reach. Mention a repo (@owner/repo) in Behavior to scope it down.",
      badge: "Connected",
      badgeTone: "success",
    };
  }
  const description =
    status === "needs_repository_access"
      ? "Connected, but no repositories are granted yet."
      : "Connect GitHub before your agent can use repositories.";
  return {
    description,
    badge: status === "needs_repository_access" ? "Choose repositories" : "Connect",
    connectEntry: entry,
  };
}

function isToolAdded(toolId: AgentToolId, config: AgentConfig) {
  return config.tools.some((tool) => tool.id === toolId);
}

function skillIdFromMentionItem(skill: AgentSkillMention) {
  return skill.id.startsWith("skill/") ? skill.id.slice("skill/".length) : null;
}

function isSkillAdded(skillId: string, config: AgentConfig) {
  return (config.skills ?? []).some((skill) => skill.id === skillId);
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
