"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { Brain, Lock, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useGoatAppData } from "@/components/GoatAppDataProvider";
import { createGoatBrainAction, switchGoatBrainAction } from "@/lib/workspace-actions";

export function GoatBrainSwitcher() {
  const { brains, activeBrain, workspace } = useGoatAppData();
  const router = useRouter();
  const pathname = usePathname();
  const [creating, setCreating] = useState(false);
  const [isPending, startTransition] = useTransition();
  const brainRouteActive = pathname === "/brain" || pathname.startsWith("/brain/");
  const routeBrainSegment = brainRouteActive ? pathname.split("/").filter(Boolean)[1] : undefined;
  const routeBrain = routeBrainSegment
    ? brains.find((brain) => encodeURIComponent(brain.id) === routeBrainSegment)
    : null;
  const highlightedBrainRef = routeBrain?.id ?? activeBrain?.id ?? null;
  const canCreateBrain = workspace.role === "admin";

  const switchBrain = (brainRef: string) => {
    const href = goatBrainHref(brainRef);
    startTransition(async () => {
      const result = await switchGoatBrainAction(brainRef);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.push(href);
    });
  };

  return (
    <>
      <div className="group/brains-title flex items-center px-2 pb-1">
        <div className="min-w-0 flex-1 text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
          Brains
        </div>
        {canCreateBrain ? (
          <button
            type="button"
            aria-label="New brain"
            title="New brain"
            onClick={() => setCreating(true)}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-ink/50 opacity-0 transition-[opacity,color,background-color] duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ink/20 group-hover/brains-title:opacity-100"
          >
            <Plus size={13} strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
      <div className="flex flex-col gap-px">
        {brains.map((brain) => {
          const active = brainRouteActive && brain.id === highlightedBrainRef;
          const rowClassName = `flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-[5px] text-left text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
            active
              ? "bg-surface-active text-ink"
              : "text-ink/90 hover:bg-surface-hover hover:text-ink"
          }`;
          const rowContent = (
            <>
              <Brain
                size={14}
                strokeWidth={1.75}
                className={`shrink-0 ${active ? "text-ink" : "text-ink/60"}`}
              />
              <span className="min-w-0 flex-1 truncate tracking-[-0.005em]">{brain.name}</span>
              {brain.visibility === "restricted" ? (
                <Lock size={11} strokeWidth={1.75} className="shrink-0 text-ink/40" />
              ) : null}
            </>
          );
          return (
            <div key={brain.id} className="group/brain flex items-center">
              {brain.id === activeBrain?.id ? (
                <Link
                  href={goatBrainHref(brain.id)}
                  prefetch
                  aria-current={active ? "page" : undefined}
                  className={rowClassName}
                >
                  {rowContent}
                </Link>
              ) : (
                <button
                  type="button"
                  disabled={isPending}
                  aria-current={active ? "true" : undefined}
                  onClick={() => switchBrain(brain.id)}
                  className={rowClassName}
                >
                  {rowContent}
                </button>
              )}
            </div>
          );
        })}
        {brains.length === 0 ? (
          <div className="px-2 py-1.5 text-[12px] text-ink-subtle">
            No brains available in this workspace.
          </div>
        ) : null}
      </div>
      {creating ? <CreateBrainDialog onClose={() => setCreating(false)} /> : null}
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
      if (result.brainRef) router.push(goatBrainHref(result.brainRef));
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
            description="All current and future members can view."
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

function goatBrainHref(brainRef: string) {
  return `/brain/${encodeURIComponent(brainRef)}`;
}

export function VisibilityOption({
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
      <div className="flex w-full max-w-[380px] flex-col gap-3 shadow-ring-xl rounded-lg bg-canvas p-4">
        <div className="text-[14px] font-semibold text-ink">{title}</div>
        {children}
      </div>
    </div>
  );
}
