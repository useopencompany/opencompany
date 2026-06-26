"use client";

import { Check, ChevronsUpDown, LoaderCircle, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState, useTransition } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  createWorkspace,
  switchWorkspace,
  type WorkspacePickerItem,
} from "@/lib/workspaces/actions";

type Space = "personal" | "workspace";

export function SpaceSwitcher({
  activeSpace,
  activeWorkspaceId,
  workspaceName,
  workspaces = [],
  personalHref = "/personal",
  // The company/workspace surface is demoted in the personal-agent-first phase. When true, the
  // switcher hides workspace rows, but keeps workspace creation reachable.
  hideWorkspace = false,
  className,
}: {
  activeSpace: Space;
  activeWorkspaceId?: string;
  workspaceName: string;
  workspaces?: WorkspacePickerItem[];
  personalHref?: string;
  hideWorkspace?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const workspaceItems = useMemo(() => {
    if (workspaces.length > 0) return workspaces;
    return activeWorkspaceId
      ? [{ id: activeWorkspaceId, name: workspaceName, workosOrganizationId: null }]
      : [];
  }, [activeWorkspaceId, workspaceName, workspaces]);
  const activeWorkspace = workspaceItems.find((workspace) => workspace.id === activeWorkspaceId);
  const activeLabel =
    activeSpace === "personal" ? "Personal" : (activeWorkspace?.name ?? workspaceName);

  function closePicker() {
    setOpen(false);
    setCreateOpen(false);
    setError(null);
  }

  function handleWorkspaceSelect(workspace: WorkspacePickerItem) {
    if (workspace.id === activeWorkspaceId && activeSpace === "workspace") {
      closePicker();
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await switchWorkspace(workspace.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      closePicker();
      router.push("/company");
      router.refresh();
    });
  }

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    startTransition(async () => {
      const result = await createWorkspace(name);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName("");
      closePicker();
      router.push("/company");
      router.refresh();
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Switch space"
          className={cn(
            "flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium tracking-[-0.005em] text-ink outline-none transition-colors duration-150 hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-ink/20 data-[state=open]:bg-surface-hover",
            className,
          )}
        >
          <span className="min-w-0 truncate">{activeLabel}</span>
          <ChevronsUpDown size={12} strokeWidth={1.9} className="ml-0.5 shrink-0 text-ink/50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[236px] p-1">
        <SpaceOption
          href={personalHref}
          active={activeSpace === "personal"}
          onSelect={() => setOpen(false)}
        >
          Personal
        </SpaceOption>
        {hideWorkspace
          ? null
          : workspaceItems.map((workspace) => (
              <WorkspaceOption
                key={workspace.id}
                workspace={workspace}
                active={activeSpace === "workspace" && workspace.id === activeWorkspaceId}
                disabled={isPending || !workspace.workosOrganizationId}
                onSelect={handleWorkspaceSelect}
              />
            ))}
        <div className="my-1 h-px bg-border" />
        {createOpen ? (
          <form onSubmit={handleCreate} className="space-y-2 p-1">
            <label className="sr-only" htmlFor="new-company-workspace-name">
              Company name
            </label>
            <input
              id="new-company-workspace-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              maxLength={80}
              placeholder="Company name"
              disabled={isPending}
              className="h-8 w-full rounded-md border border-border bg-canvas px-2 text-[13px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong focus:ring-2 focus:ring-ink/[0.04] disabled:opacity-60"
            />
            <div className="flex items-center gap-1.5">
              <button
                type="submit"
                disabled={isPending}
                className="inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md bg-ink px-2 text-[12px] font-medium text-canvas transition-opacity disabled:opacity-60"
              >
                {isPending ? <LoaderCircle size={12} className="animate-spin" /> : null}
                Create
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={() => {
                  setCreateOpen(false);
                  setError(null);
                }}
                className="h-7 rounded-md px-2 text-[12px] font-medium text-ink-muted hover:bg-surface-hover hover:text-ink disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => {
              setCreateOpen(true);
              setError(null);
            }}
            className="flex h-7 w-full min-w-0 items-center gap-2 rounded-[5px] px-2 text-left text-[12.5px] font-medium tracking-[-0.005em] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <Plus size={13} strokeWidth={2} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">Create company...</span>
          </button>
        )}
        {error ? (
          <p className="px-2 pb-1 pt-1 text-[11.5px] leading-4 text-danger">{error}</p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function WorkspaceOption({
  workspace,
  active,
  disabled,
  onSelect,
}: {
  workspace: WorkspacePickerItem;
  active: boolean;
  disabled: boolean;
  onSelect: (workspace: WorkspacePickerItem) => void;
}) {
  return (
    <button
      type="button"
      title={workspace.name}
      aria-current={active ? "page" : undefined}
      disabled={disabled}
      onClick={() => onSelect(workspace)}
      className={cn(
        "flex h-7 w-full min-w-0 items-center gap-2 rounded-[5px] px-2 text-left text-[12.5px] font-medium tracking-[-0.005em] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50",
        active ? "text-ink" : "text-ink-subtle hover:bg-surface-hover hover:text-ink",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
      <Check
        size={13}
        strokeWidth={2}
        className={cn("shrink-0 text-ink", active ? "opacity-100" : "opacity-0")}
      />
    </button>
  );
}

function SpaceOption({
  href,
  active,
  title,
  onSelect,
  children,
}: {
  href: string;
  active: boolean;
  title?: string;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      title={title}
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-7 min-w-0 items-center gap-2 rounded-[5px] px-2 text-[12.5px] font-medium tracking-[-0.005em] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20",
        active ? "text-ink" : "text-ink-subtle hover:bg-surface-hover hover:text-ink",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <Check
        size={13}
        strokeWidth={2}
        className={cn("shrink-0 text-ink", active ? "opacity-100" : "opacity-0")}
      />
    </Link>
  );
}
