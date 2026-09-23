"use client";

import { Button } from "@opencompany/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@opencompany/ui/components/tooltip";
import { cn } from "@opencompany/ui/lib/utils";
import { Building2, Check, ChevronDown, LockKeyhole } from "lucide-react";
import { type ReactNode, useState } from "react";

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

const SCOPE_TABS = [
  { value: "personal", label: "Personal" },
  { value: "company", label: "Company" },
] as const;

export function ScopeFilterTabs({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ScopeFilter;
  onChange: (value: ScopeFilter) => void;
}) {
  return <ScopePills label={label} options={SCOPE_FILTERS} value={value} onChange={onChange} />;
}

/** Switches between two scoped views of one surface, where "All" would mix unlike things. */
export function ScopeTabs({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Scope;
  onChange: (value: Scope) => void;
}) {
  return <ScopePills label={label} options={SCOPE_TABS} value={value} onChange={onChange} />;
}

function ScopePills<T extends ScopeFilter>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      {options.map((filter) => (
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

const SCOPE_OPTIONS = [
  {
    value: "personal",
    label: "Personal",
    icon: LockKeyhole,
    hint: "Only you can see and run it",
  },
  {
    value: "company",
    label: "Company",
    icon: Building2,
    hint: "Everyone in the workspace can run and edit it",
  },
] as const;

function ScopeIcon({ scope, className }: { scope: Scope; className?: string }) {
  const Icon = scope === "company" ? Building2 : LockKeyhole;
  return (
    <Icon
      size={12}
      strokeWidth={1.8}
      aria-hidden="true"
      className={cn("text-ink-subtle", className)}
    />
  );
}

/**
 * Compact visibility control for an item header, sized to sit beside a status picker. Use this
 * where visibility is a header attribute; use {@link ScopeField} where it is a labelled form row.
 */
export function ScopePicker({
  scope,
  onChange,
  managedTooltip,
  disabled,
  canManage = true,
}: {
  scope: Scope;
  onChange: (scope: Scope) => void;
  managedTooltip: string;
  disabled?: boolean;
  canManage?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const label = scope === "company" ? "Company" : "Personal";

  if (!canManage) {
    return (
      <Tooltip>
        <TooltipTrigger
          aria-label={`Visibility: ${label}, managed by the creator or an admin`}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-surface-muted px-2.5 text-[12.5px] font-medium text-ink-subtle"
        >
          <ScopeIcon scope={scope} />
          {label}
        </TooltipTrigger>
        <TooltipContent>{managedTooltip}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger
        type="button"
        disabled={disabled}
        aria-label={`Visibility: ${label}`}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-default disabled:hover:bg-surface data-[popup-open]:bg-surface-hover"
      >
        <ScopeIcon scope={scope} />
        {label}
        {disabled ? null : <ChevronDown size={12} strokeWidth={2} className="text-ink-subtle" />}
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[248px] bg-surface p-1 text-ink">
        {SCOPE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              onChange(option.value);
              setOpen(false);
            }}
            className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink transition-colors duration-150 hover:bg-surface-hover"
          >
            <option.icon
              size={12}
              strokeWidth={1.8}
              aria-hidden="true"
              className="mt-1 shrink-0 text-ink-subtle"
            />
            <span className="flex flex-1 flex-col">
              {option.label}
              <span className="text-[11.5px] leading-4 text-ink-subtle">{option.hint}</span>
            </span>
            {scope === option.value ? (
              <Check size={13} strokeWidth={2} className="mt-0.5 shrink-0 text-ink" />
            ) : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
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
