"use client";

import { Button } from "@opencompany/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@opencompany/ui/components/tooltip";
import { cn } from "@opencompany/ui/lib/utils";
import { LockKeyhole } from "lucide-react";
import type { ReactNode } from "react";

// Skills and Workflows share one visibility model: a company item belongs to the workspace, a
// personal one only to its creator. These primitives keep both surfaces reading the same way.
export type Scope = "personal" | "company";
export type ScopeFilter = "all" | Scope;

export const SCOPE_FILTERS = [
  { value: "all", label: "All" },
  { value: "company", label: "Company" },
  { value: "personal", label: "Personal" },
] as const;

export const SCOPE_SELECT_CLASS =
  "h-9 rounded-lg border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-70";

export function ScopeBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[11px] text-ink-subtle">
      {children}
    </span>
  );
}

export function ScopeFilterTabs({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ScopeFilter;
  onChange: (value: ScopeFilter) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      {SCOPE_FILTERS.map((filter) => (
        <Button
          key={filter.value}
          variant={value === filter.value ? "default" : "secondary"}
          size="sm"
          aria-pressed={value === filter.value}
          onClick={() => onChange(filter.value)}
          className={cn(
            "h-8 rounded-full px-3 text-[13px] font-normal shadow-none",
            value !== filter.value && "text-ink-muted hover:text-ink",
          )}
        >
          {filter.label}
        </Button>
      ))}
    </div>
  );
}

export function ScopeField({
  scope,
  onChange,
  hint,
  managedTooltip,
  disabled,
  canManage = true,
}: {
  scope: Scope;
  onChange: (scope: Scope) => void;
  hint: (scope: Scope) => string;
  managedTooltip: string;
  disabled?: boolean;
  canManage?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-[12px] font-medium text-ink-subtle">Visibility</span>
      {canManage ? (
        <select
          aria-label="Visibility"
          value={scope}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as Scope)}
          className={cn(SCOPE_SELECT_CLASS, "w-auto")}
        >
          <option value="personal">Personal</option>
          <option value="company">Company</option>
        </select>
      ) : (
        <Tooltip>
          <TooltipTrigger
            aria-label="Visibility managed by the creator or an admin"
            className="inline-flex h-9 items-center gap-2 rounded-md bg-surface-muted px-2.5 text-[13px] text-ink-subtle"
          >
            {scope === "company" ? "Company" : "Personal"}
            <LockKeyhole size={12} aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>{managedTooltip}</TooltipContent>
        </Tooltip>
      )}
      <span className="text-[12px] leading-5 text-ink-subtle">{hint(scope)}</span>
    </div>
  );
}
