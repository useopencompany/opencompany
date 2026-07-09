"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { Brain, Check, Copy, Lock, Plus, Settings2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  type GoatBrainSummaryView,
  type GoatWorkspaceView,
  useGoatAppData,
} from "@/components/GoatAppDataProvider";
import { useHydrated } from "@/components/useHydrated";
import {
  createGoatBrainAction,
  type GoatWorkspaceMemberView,
  getGoatBrainAccessDetailsAction,
  setGoatBrainAccessAction,
  switchGoatBrainAction,
} from "@/lib/workspace-actions";

export function GoatBrainSwitcher() {
  const { workspace, brains, activeBrain } = useGoatAppData();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [accessBrain, setAccessBrain] = useState<GoatBrainSummaryView | null>(null);
  const [isPending, startTransition] = useTransition();

  const switchBrain = (brainId: string) => {
    const href = goatBrainHref(brainId);
    if (brainId === activeBrain?.id) {
      router.push(href);
      return;
    }
    startTransition(async () => {
      const result = await switchGoatBrainAction(brainId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.push(href);
    });
  };

  return (
    <>
      <div className="flex flex-col gap-px">
        {brains.map((brain) => {
          const active = brain.id === activeBrain?.id;
          return (
            <div key={brain.id} className="group/brain flex items-center">
              <button
                type="button"
                disabled={isPending}
                aria-current={active ? "true" : undefined}
                onClick={() => switchBrain(brain.id)}
                className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-[5px] text-left text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
                  active
                    ? "bg-surface-active text-ink"
                    : "text-ink/90 hover:bg-surface-hover hover:text-ink"
                }`}
              >
                <Brain
                  size={14}
                  strokeWidth={1.75}
                  className={`shrink-0 ${active ? "text-ink" : "text-ink/60"}`}
                />
                <span className="min-w-0 flex-1 truncate tracking-[-0.005em]">{brain.name}</span>
                {brain.visibility === "restricted" ? (
                  <Lock size={11} strokeWidth={1.75} className="shrink-0 text-ink/40" />
                ) : null}
              </button>
              {workspace.role === "admin" ? (
                <button
                  type="button"
                  aria-label={`Manage access to ${brain.name}`}
                  onClick={() => setAccessBrain(brain)}
                  className="rounded-md p-1.5 text-ink/0 transition-colors hover:bg-surface-hover hover:text-ink/80 group-hover/brain:text-ink/50"
                >
                  <Settings2 size={13} strokeWidth={1.75} />
                </button>
              ) : null}
            </div>
          );
        })}
        {brains.length === 0 ? (
          <div className="px-2 py-1.5 text-[12px] text-ink-subtle">
            No brains available in this workspace.
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-left text-[13px] text-ink/60 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          <Plus size={14} strokeWidth={1.75} className="shrink-0" />
          <span className="truncate tracking-[-0.005em]">New brain</span>
        </button>
      </div>
      {creating ? <CreateBrainDialog onClose={() => setCreating(false)} /> : null}
      {accessBrain ? (
        <BrainAccessDialog
          brain={accessBrain}
          workspace={workspace}
          onClose={() => setAccessBrain(null)}
        />
      ) : null}
    </>
  );
}

function CreateBrainDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"workspace" | "restricted">("workspace");
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    if (!name.trim()) {
      toast.error("Give the brain a name.");
      return;
    }
    startTransition(async () => {
      const result = await createGoatBrainAction({ name, visibility });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      onClose();
      if (result.brainId) router.push(goatBrainHref(result.brainId));
      else router.refresh();
    });
  };

  return (
    <DialogFrame title="New brain" onClose={onClose}>
      <label className="flex flex-col gap-1 text-[12px] text-ink-subtle">
        Name
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          placeholder="Leadership, Product, …"
          className="rounded-md border border-ink/10 bg-canvas px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-ink/25"
        />
      </label>
      <div className="flex flex-col gap-1 text-[12px] text-ink-subtle">
        Access
        <div className="flex flex-col gap-1">
          <VisibilityOption
            checked={visibility === "workspace"}
            onSelect={() => setVisibility("workspace")}
            title="Everyone in the workspace"
            description="All current and future members can view and edit."
          />
          <VisibilityOption
            checked={visibility === "restricted"}
            onSelect={() => setVisibility("restricted")}
            title="Only specific members"
            description="Starts with just you; manage members from the brain list."
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-3 py-1.5 text-[13px] text-ink/70 transition-colors hover:bg-surface-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={submit}
          className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-60"
        >
          {isPending ? "Creating…" : "Create brain"}
        </button>
      </div>
    </DialogFrame>
  );
}

export function BrainAccessDialog({
  brain,
  workspace,
  onClose,
}: {
  brain: GoatBrainSummaryView;
  workspace: GoatWorkspaceView;
  onClose: () => void;
}) {
  const router = useRouter();
  const [visibility, setVisibility] = useState<"workspace" | "restricted">(brain.visibility);
  const [members, setMembers] = useState<GoatWorkspaceMemberView[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    void getGoatBrainAccessDetailsAction(brain.id).then((details) => {
      if (cancelled || !details) return;
      setVisibility(details.visibility);
      setMembers(details.workspaceMembers);
      setSelected(new Set(details.memberWorkosIds));
    });
    return () => {
      cancelled = true;
    };
  }, [brain.id]);

  const toggleMember = (userWorkosId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(userWorkosId)) {
        next.delete(userWorkosId);
      } else {
        next.add(userWorkosId);
      }
      return next;
    });
  };

  const save = () => {
    startTransition(async () => {
      const result = await setGoatBrainAccessAction({
        brainId: brain.id,
        visibility,
        memberWorkosIds: [...selected],
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  };

  return (
    <DialogFrame title={`Access to ${brain.name}`} onClose={onClose}>
      <div className="flex flex-col gap-1">
        <VisibilityOption
          checked={visibility === "workspace"}
          onSelect={() => setVisibility("workspace")}
          title={`Everyone in ${workspace.name}`}
          description="All current and future members can view and edit."
        />
        <VisibilityOption
          checked={visibility === "restricted"}
          onSelect={() => setVisibility("restricted")}
          title="Only specific members"
          description="Pick who can view and edit this brain."
        />
      </div>
      {visibility === "restricted" ? (
        <div className="flex max-h-[200px] flex-col gap-px overflow-y-auto rounded-md border border-ink/10 p-1">
          {members === null ? (
            <div className="px-2 py-1.5 text-[12px] text-ink-subtle">Loading members…</div>
          ) : (
            members.map((member) => (
              <label
                key={member.userWorkosId}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover"
              >
                <input
                  type="checkbox"
                  checked={selected.has(member.userWorkosId)}
                  onChange={() => toggleMember(member.userWorkosId)}
                  className="accent-ink"
                />
                <span className="min-w-0 flex-1 truncate">{member.name}</span>
                <span className="shrink-0 text-[11px] text-ink-subtle">{member.role}</span>
              </label>
            ))
          )}
        </div>
      ) : null}
      <ClaudeConnectorBlock brainId={brain.id} />
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-3 py-1.5 text-[13px] text-ink/70 transition-colors hover:bg-surface-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={save}
          className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-60"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </DialogFrame>
  );
}

function goatBrainHref(brainId: string) {
  return `/brain/${encodeURIComponent(brainId)}`;
}

function ClaudeConnectorBlock({ brainId }: { brainId: string }) {
  const [copied, setCopied] = useState(false);
  const hydrated = useHydrated();
  const origin = hydrated ? window.location.origin.replace(/\/+$/, "") : "";
  const connectorPath = `/api/mcp/${encodeURIComponent(brainId)}/mcp`;
  const connectorUrl = origin ? `${origin}${connectorPath}` : connectorPath;

  const copyConnectorUrl = async () => {
    if (!origin) return;
    try {
      await navigator.clipboard.writeText(connectorUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("Could not copy connector URL.");
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-ink/10 p-2.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <span className="block text-[12px] font-medium text-ink">Connect to Claude</span>
          <code className="block truncate text-[12px] leading-5 text-ink-subtle">
            {connectorUrl}
          </code>
        </div>
        <button
          type="button"
          onClick={copyConnectorUrl}
          disabled={!origin}
          aria-label="Copy Claude connector URL"
          title="Copy Claude connector URL"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          {copied ? <Check size={15} strokeWidth={2} /> : <Copy size={15} strokeWidth={2} />}
        </button>
      </div>
      <p className="text-[11.5px] leading-4 text-ink-subtle">
        Claude -&gt; Settings -&gt; Connectors -&gt; Add custom connector, then sign in with your
        Goat account.
      </p>
    </div>
  );
}

function VisibilityOption({
  checked,
  onSelect,
  title,
  description,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={checked}
      className={`flex flex-col items-start gap-0.5 rounded-md border px-2.5 py-2 text-left transition-colors ${
        checked ? "border-ink/30 bg-surface-active" : "border-ink/10 hover:bg-surface-hover"
      }`}
    >
      <span className="text-[13px] font-medium text-ink">{title}</span>
      <span className="text-[11.5px] text-ink-subtle">{description}</span>
    </button>
  );
}

function DialogFrame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="flex w-full max-w-[380px] flex-col gap-3 rounded-lg bg-canvas p-4 shadow-xl">
        <div className="text-[14px] font-semibold text-ink">{title}</div>
        {children}
      </div>
    </div>
  );
}
