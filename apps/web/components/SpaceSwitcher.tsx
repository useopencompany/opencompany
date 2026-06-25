"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type Space = "personal" | "workspace";

export function SpaceSwitcher({
  activeSpace,
  workspaceName,
  workspaceHref = "/company",
  personalHref = "/personal",
  // The company/workspace surface is demoted in the personal-agent-first phase. When true, the
  // switcher shows only the Personal space so the company tab stays out of the default UX.
  hideWorkspace = false,
  className,
}: {
  activeSpace: Space;
  workspaceName: string;
  workspaceHref?: string;
  personalHref?: string;
  hideWorkspace?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  const activeLabel = activeSpace === "personal" ? "Personal" : workspaceName;

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
      <PopoverContent align="start" sideOffset={6} className="w-[200px] p-1">
        <SpaceOption
          href={personalHref}
          active={activeSpace === "personal"}
          onSelect={() => setOpen(false)}
        >
          Personal
        </SpaceOption>
        {hideWorkspace ? null : (
          <SpaceOption
            href={workspaceHref}
            active={activeSpace === "workspace"}
            title={workspaceName}
            onSelect={() => setOpen(false)}
          >
            {workspaceName}
          </SpaceOption>
        )}
      </PopoverContent>
    </Popover>
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
