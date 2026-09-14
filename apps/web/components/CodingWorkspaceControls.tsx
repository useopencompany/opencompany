"use client";

import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

/** Icon-only control used across the coding workspace panel's toolbars. */
export function PanelButton({
  label,
  children,
  disabled = false,
  onClick,
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-[11px] font-medium text-ink-subtle hover:bg-surface-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** Centred empty/loading/error state filling the panel's content area. */
export function WorkspaceNotice({
  title,
  detail,
  busy = false,
  actionLabel,
  onAction,
}: {
  title: string;
  detail?: string;
  busy?: boolean;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
      <div className="flex max-w-xs flex-col items-center gap-2">
        {busy ? <LoaderCircle size={18} className="animate-spin text-ink-subtle" /> : null}
        <p className="text-[13px] font-medium text-ink">{title}</p>
        {detail ? <p className="text-[12px] leading-5 text-ink-subtle">{detail}</p> : null}
        {actionLabel && onAction ? (
          <button
            type="button"
            onClick={onAction}
            className="mt-2 rounded-md border border-border bg-canvas px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-surface-hover"
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
