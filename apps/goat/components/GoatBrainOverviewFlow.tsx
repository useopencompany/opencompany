"use client";

import { Brain, Settings2, UserRound, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { GoatBrainSummaryView, GoatWorkspaceView } from "@/components/GoatAppDataProvider";
import { resolveGoatBrainSourceState, SourceProviderCard } from "@/components/GoatBrainSourceCards";
import {
  type GoatBrainSourcesDetails,
  getGoatBrainSourcesAction,
} from "@/lib/brain-source-actions";
import {
  GOAT_BRAIN_SOURCE_PROVIDERS,
  type GoatBrainSourceProviderDef,
} from "@/lib/brain-sources/registry";
import {
  type GoatWorkspaceMemberView,
  getGoatBrainAccessDetailsAction,
} from "@/lib/workspace-actions";

const MAX_VISIBLE_PEOPLE = 5;

type AccessDetails = {
  visibility: "workspace" | "restricted";
  memberWorkosIds: string[];
  workspaceMembers: GoatWorkspaceMemberView[];
};

type FlowLink = {
  id: string;
  d: string;
  kind: "source" | "person";
  active: boolean;
};

function subscribeToReducedMotion(onStoreChange: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

export function GoatBrainOverviewFlow({
  brain,
  workspace,
  onManageAccess,
}: {
  brain: GoatBrainSummaryView;
  workspace: GoatWorkspaceView;
  onManageAccess: () => void;
}) {
  const [details, setDetails] = useState<GoatBrainSourcesDetails | null>(null);
  const [access, setAccess] = useState<AccessDetails | null>(null);
  const [configuring, setConfiguring] = useState<GoatBrainSourceProviderDef | null>(null);

  const reloadSources = useCallback(async () => {
    const next = await getGoatBrainSourcesAction(brain.id);
    setDetails(next);
  }, [brain.id]);

  useEffect(() => {
    let cancelled = false;
    void getGoatBrainSourcesAction(brain.id).then((next) => {
      if (!cancelled) setDetails(next);
    });
    void getGoatBrainAccessDetailsAction(brain.id).then((next) => {
      if (!cancelled && next) setAccess(next);
    });
    return () => {
      cancelled = true;
    };
  }, [brain.id]);

  const memberIds = new Set(access?.memberWorkosIds ?? []);
  const people = access
    ? access.visibility === "workspace"
      ? access.workspaceMembers
      : access.workspaceMembers.filter((member) => memberIds.has(member.userWorkosId))
    : null;

  return (
    <div className="flex flex-col gap-3">
      <FlowDiagram
        brain={brain}
        workspace={workspace}
        details={details}
        access={access}
        people={people}
        onConfigure={setConfiguring}
        onManageAccess={onManageAccess}
      />
      {configuring ? (
        <SourceConfigDialog
          brainRef={brain.id}
          provider={configuring}
          details={details}
          onChanged={reloadSources}
          onClose={() => setConfiguring(null)}
        />
      ) : null}
    </div>
  );
}

function FlowDiagram({
  brain,
  workspace,
  details,
  access,
  people,
  onConfigure,
  onManageAccess,
}: {
  brain: GoatBrainSummaryView;
  workspace: GoatWorkspaceView;
  details: GoatBrainSourcesDetails | null;
  access: AccessDetails | null;
  people: GoatWorkspaceMemberView[] | null;
  onConfigure: (provider: GoatBrainSourceProviderDef) => void;
  onManageAccess: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const brainNodeRef = useRef<HTMLDivElement>(null);
  const sourceRefs = useRef(new Map<string, HTMLDivElement>());
  const personRefs = useRef(new Map<string, HTMLDivElement>());
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [links, setLinks] = useState<FlowLink[]>([]);
  const reduceMotion = usePrefersReducedMotion();

  const visiblePeople = people ? people.slice(0, MAX_VISIBLE_PEOPLE) : [];
  const overflowCount = people ? people.length - visiblePeople.length : 0;

  const measure = useCallback(() => {
    const container = containerRef.current;
    const brainEl = brainNodeRef.current;
    if (!container || !brainEl) return;
    const crect = container.getBoundingClientRect();
    if (crect.width === 0) return;
    const brect = brainEl.getBoundingClientRect();
    const brainY = brect.top - crect.top + brect.height / 2;
    const brainLeft = { x: brect.left - crect.left, y: brainY };
    const brainRight = { x: brect.right - crect.left, y: brainY };
    const curve = (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const dx = Math.max(24, (to.x - from.x) / 2);
      return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
    };
    const next: FlowLink[] = [];
    for (const provider of GOAT_BRAIN_SOURCE_PROVIDERS) {
      const el = sourceRefs.current.get(provider.id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const from = { x: rect.right - crect.left, y: rect.top - crect.top + rect.height / 2 };
      const state = resolveGoatBrainSourceState(provider.id, details);
      next.push({
        id: `source-${provider.id}`,
        d: curve(from, brainLeft),
        kind: "source",
        active: provider.available && state.enabled,
      });
    }
    for (const [id, el] of personRefs.current) {
      const rect = el.getBoundingClientRect();
      const to = { x: rect.left - crect.left, y: rect.top - crect.top + rect.height / 2 };
      next.push({ id: `person-${id}`, d: curve(brainRight, to), kind: "person", active: true });
    }
    setSize({ width: crect.width, height: crect.height });
    setLinks(next);
  }, [details]);

  useLayoutEffect(() => {
    measure();
  }, [measure, access, people?.length]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(container);
    return () => observer.disconnect();
  }, [measure]);

  const activeSourceLinks = links.filter((link) => link.kind === "source" && link.active);

  return (
    <div ref={containerRef} className="relative">
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox={`0 0 ${Math.max(size.width, 1)} ${Math.max(size.height, 1)}`}
        preserveAspectRatio="none"
      >
        {links.map((link) => (
          <path
            key={link.id}
            d={link.d}
            fill="none"
            strokeWidth={1.25}
            strokeDasharray={link.kind === "source" && !link.active ? "3 4" : undefined}
            className={
              link.kind === "person"
                ? "stroke-ink/15"
                : link.active
                  ? "stroke-ink/25"
                  : "stroke-ink/10"
            }
          />
        ))}
        {!reduceMotion
          ? activeSourceLinks.map((link, index) => (
              <circle key={`dot-${link.id}`} r={2} className="fill-success opacity-70">
                <animateMotion
                  dur="3.6s"
                  begin={`${(index * 1.1).toFixed(1)}s`}
                  repeatCount="indefinite"
                  path={link.d}
                  calcMode="spline"
                  keyPoints="0;1"
                  keyTimes="0;1"
                  keySplines="0.45 0 0.55 1"
                />
              </circle>
            ))
          : null}
      </svg>

      <div className="relative flex items-stretch justify-between gap-8 py-2">
        <div className="flex w-full max-w-[300px] flex-col gap-2">
          <span className="px-0.5 text-[11px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
            Sources
          </span>
          {details === null ? (
            <div className="px-0.5 py-1 text-[12px] text-ink-subtle">Loading sources…</div>
          ) : (
            GOAT_BRAIN_SOURCE_PROVIDERS.map((provider) => (
              <SourceFlowNode
                key={provider.id}
                provider={provider}
                details={details}
                onConfigure={() => onConfigure(provider)}
                nodeRef={(el) => {
                  if (el) sourceRefs.current.set(provider.id, el);
                  else sourceRefs.current.delete(provider.id);
                }}
              />
            ))
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2">
          <div
            ref={brainNodeRef}
            className="flex h-[76px] w-[76px] items-center justify-center rounded-2xl border border-ink/15 bg-surface-muted text-ink shadow-sm"
          >
            <Brain size={28} strokeWidth={1.8} />
          </div>
          <span className="max-w-[180px] truncate text-center text-[12.5px] font-medium text-ink">
            {brain.name}
          </span>
        </div>

        <div className="flex w-full max-w-[260px] flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2 px-0.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
              Access
            </span>
            <button
              type="button"
              onClick={onManageAccess}
              className="text-[11px] font-medium text-ink-subtle transition-colors hover:text-ink"
            >
              Manage
            </button>
          </div>
          {access?.visibility === "workspace" ? (
            <p className="px-0.5 text-[10.5px] leading-4 text-ink-subtle">
              Everyone in {workspace.name}
            </p>
          ) : null}
          {people === null ? (
            <div className="px-0.5 py-1 text-[12px] text-ink-subtle">Loading members…</div>
          ) : people.length === 0 ? (
            <div className="rounded-md border border-dashed border-ink/15 px-2 py-1.5 text-[11.5px] text-ink-subtle">
              No members yet
            </div>
          ) : (
            <>
              {visiblePeople.map((member) => (
                <div
                  key={member.userWorkosId}
                  ref={(el) => {
                    if (el) personRefs.current.set(member.userWorkosId, el);
                    else personRefs.current.delete(member.userWorkosId);
                  }}
                  className="flex items-center gap-2 rounded-md border border-ink/10 bg-canvas px-2 py-1.5"
                >
                  {member.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={member.avatarUrl}
                      alt=""
                      className="h-5 w-5 shrink-0 rounded-full bg-surface-muted object-cover"
                    />
                  ) : (
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-muted">
                      <UserRound size={11} strokeWidth={1.75} className="text-ink/60" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink/90">
                    {member.name}
                  </span>
                </div>
              ))}
              {overflowCount > 0 ? (
                <div
                  ref={(el) => {
                    if (el) personRefs.current.set("__overflow", el);
                    else personRefs.current.delete("__overflow");
                  }}
                  className="flex items-center gap-2 rounded-md border border-ink/10 bg-canvas px-2 py-1.5 text-[12px] text-ink-subtle"
                >
                  +{overflowCount} more
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SourceFlowNode({
  provider,
  details,
  onConfigure,
  nodeRef,
}: {
  provider: GoatBrainSourceProviderDef;
  details: GoatBrainSourcesDetails | null;
  onConfigure: () => void;
  nodeRef: (el: HTMLDivElement | null) => void;
}) {
  const Icon = provider.icon;
  const state = resolveGoatBrainSourceState(provider.id, details);
  const statusLabel = !provider.available
    ? "Coming soon"
    : state.enabled
      ? "Ingesting"
      : state.connected || state.source
        ? "Off"
        : "Not connected";

  return (
    <div
      ref={nodeRef}
      className={`flex items-center gap-2 rounded-md border bg-canvas px-2 py-1.5 ${
        state.enabled ? "border-ink/15" : "border-ink/10"
      } ${provider.available ? "" : "opacity-55"}`}
    >
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink">
        <Icon size={13} strokeWidth={1.8} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] font-medium text-ink">{provider.name}</span>
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              state.enabled ? "bg-success" : "bg-ink/20"
            }`}
          />
        </div>
        <span className="block truncate text-[10.5px] leading-4 text-ink-subtle">
          {statusLabel}
        </span>
      </div>
      {provider.available ? (
        <button
          type="button"
          onClick={onConfigure}
          aria-label={`Configure ${provider.name}`}
          title={`Configure ${provider.name}`}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <Settings2 size={13} strokeWidth={1.8} />
        </button>
      ) : null}
    </div>
  );
}

function SourceConfigDialog({
  brainRef,
  provider,
  details,
  onChanged,
  onClose,
}: {
  brainRef: string;
  provider: GoatBrainSourceProviderDef;
  details: GoatBrainSourcesDetails | null;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`${provider.name} source settings`}
    >
      <div className="flex max-h-[80vh] w-full max-w-[460px] flex-col gap-3 overflow-y-auto shadow-ring-xl rounded-lg bg-canvas p-4">
        <div className="flex items-center justify-between">
          <span className="text-[14px] font-semibold text-ink">{provider.name} source</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <X size={15} strokeWidth={2} />
          </button>
        </div>
        <SourceProviderCard
          brainRef={brainRef}
          provider={provider}
          details={details}
          onChanged={onChanged}
        />
      </div>
    </div>
  );
}
