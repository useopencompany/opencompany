"use client";

import { ChevronDown } from "lucide-react";
import type { DragEventHandler, ReactNode } from "react";
import { useCallback, useSyncExternalStore } from "react";

/**
 * Every collapsible sidebar section (Bots, Projects, Recents) shares one header shape and one
 * remembered-collapse store, so they behave and read identically.
 */

// Keyed by storage key so two sections never wake each other's subscribers.
const subscribersByKey = new Map<string, Set<() => void>>();

function subscribersFor(storageKey: string) {
  const existing = subscribersByKey.get(storageKey);
  if (existing) return existing;
  const created = new Set<() => void>();
  subscribersByKey.set(storageKey, created);
  return created;
}

function getExpandedServerSnapshot() {
  return false;
}

export function useCollapsedSidebarSection(storageKey: string) {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const subscribers = subscribersFor(storageKey);
      subscribers.add(onStoreChange);

      function handleStorage(event: StorageEvent) {
        if (event.key === storageKey) onStoreChange();
      }

      window.addEventListener("storage", handleStorage);
      return () => {
        subscribers.delete(onStoreChange);
        window.removeEventListener("storage", handleStorage);
      };
    },
    [storageKey],
  );

  const getSnapshot = useCallback(
    // Expanded by default: only an explicit "true" (the user collapsed it before) hides the list.
    () => window.localStorage.getItem(storageKey) === "true",
    [storageKey],
  );

  const collapsed = useSyncExternalStore(subscribe, getSnapshot, getExpandedServerSnapshot);

  const setCollapsed = useCallback(
    (next: boolean) => {
      window.localStorage.setItem(storageKey, String(next));
      for (const subscriber of subscribersFor(storageKey)) subscriber();
    },
    [storageKey],
  );

  const toggle = useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed]);
  // Already-open sections stay untouched rather than writing the same value back out.
  const expand = useCallback(() => {
    if (collapsed) setCollapsed(false);
  }, [collapsed, setCollapsed]);

  return { collapsed, toggle, expand };
}

/**
 * The trailing action on a section header (a "+" for Bots and Projects). Hidden until the header is
 * hovered or focused so the resting sidebar stays quiet; it needs `group/header` on the header row,
 * which `SidebarSectionHeader` provides. A coarse pointer has no hover to reveal it with, so on
 * touch it stays visible -- the sidebar's mobile drawer renders these same headers.
 */
export const SIDEBAR_SECTION_ACTION_CLASSNAME =
  "ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink/50 opacity-0 transition-opacity duration-150 hover:bg-surface-active hover:text-ink focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 group-hover/header:opacity-100 group-focus-within/header:opacity-100 pointer-coarse:opacity-100";

export function SidebarSectionHeader({
  label,
  collapsed,
  onToggle,
  listId,
  action,
  onDragOver,
  onDrop,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  /** The list this header expands, so assistive tech can follow the relationship. */
  listId: string;
  action?: ReactNode;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
}) {
  return (
    <div
      className="group/header mx-2 flex items-center gap-1 rounded-md px-2 pb-1 pt-0.5"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        // Only points at the list while it exists; aria-expanded carries the state either way.
        aria-controls={collapsed ? undefined : listId}
        className="group/toggle flex min-w-0 items-center gap-1 text-[11px] font-medium tracking-wide text-ink-subtle transition-colors duration-150 hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <span className="truncate">{label}</span>
        {/* One chevron in both states: down when open, rotated to point right when closed, so a
            collapsed section still reads as "there is more here". */}
        <ChevronDown
          size={12}
          strokeWidth={2}
          aria-hidden="true"
          className={`shrink-0 text-ink/40 transition-transform duration-150 group-hover/toggle:text-ink/70 ${
            collapsed ? "-rotate-90" : ""
          }`}
        />
      </button>
      {action}
    </div>
  );
}
