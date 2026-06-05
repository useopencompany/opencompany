"use client";

import type { JsonValue } from "@opencompany/agent-runtime/types";
import {
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Cpu,
  MessagesSquare,
  Plug,
  Sparkles,
  Wrench,
} from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { ADD_SKILL_MENTION_ID, type AgentMentionItem } from "./tools";

export type MentionListHandle = {
  onKeyDown: (event: KeyboardEvent) => boolean;
};

type Props = {
  items: AgentMentionItem[];
  query?: string;
  showCategories?: boolean;
  command: (item: { id: string; label: string } & Record<string, JsonValue>) => void;
  onSelect?: (item: AgentMentionItem) => void;
};

export const MentionList = forwardRef<MentionListHandle, Props>(function MentionList(
  { items, query = "", showCategories = true, command, onSelect },
  ref,
) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeKind, setActiveKind] = useState<AgentMentionItem["kind"] | null>(null);
  const normalizedQuery = query.trim().toLowerCase();

  const categoryRows = [
    {
      type: "category" as const,
      kind: "model" as const,
      label: "Models",
      description: `${items.filter((item) => item.kind === "model").length} available`,
      icon: Cpu,
    },
    {
      type: "category" as const,
      kind: "tool" as const,
      label: "Tools",
      description: `${items.filter((item) => item.kind === "tool").length} available`,
      icon: Wrench,
    },
    {
      type: "category" as const,
      kind: "agent" as const,
      label: "Agents",
      description: `${items.filter((item) => item.kind === "agent").length} available`,
      icon: MessagesSquare,
    },
    {
      type: "category" as const,
      kind: "integration" as const,
      label: "Work integrations",
      description: `${items.filter((item) => item.kind === "integration").length} available`,
      icon: Plug,
    },
    {
      type: "category" as const,
      kind: "skill" as const,
      label: "Skills",
      description: `${items.filter((item) => item.kind === "skill").length} available`,
      icon: Sparkles,
    },
    {
      type: "category" as const,
      kind: "schedule" as const,
      label: "Schedules",
      description: `${items.filter((item) => item.kind === "schedule").length} available`,
      icon: Clock3,
    },
    {
      type: "category" as const,
      kind: "hook" as const,
      label: "Hooks",
      description: `${items.filter((item) => item.kind === "hook").length} available`,
      icon: Clock3,
    },
    {
      type: "category" as const,
      kind: "brain" as const,
      label: "Brain",
      description: `${items.filter((item) => item.kind === "brain").length} available`,
      icon: BookOpenText,
    },
  ].filter((row) => items.some((item) => item.kind === row.kind));

  const visibleItems =
    activeKind && normalizedQuery.length === 0
      ? items.filter((item) => item.kind === activeKind)
      : items;

  const rows =
    showCategories && normalizedQuery.length === 0 && !activeKind
      ? categoryRows
      : visibleItems.map((item) => ({ type: "item" as const, item }));

  useEffect(() => {
    setSelectedIndex(0);
  }, [activeKind, items, query]);

  useEffect(() => {
    if (normalizedQuery.length > 0) setActiveKind(null);
  }, [normalizedQuery]);

  const select = (index: number) => {
    const row = rows[index];
    if (!row) return;
    if (row.type === "category") {
      setActiveKind(row.kind);
      setSelectedIndex(0);
      return;
    }
    command(mentionCommandItem(row.item));
    onSelect?.(row.item);
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      if (event.key === "ArrowLeft" && activeKind) {
        setActiveKind(null);
        setSelectedIndex(0);
        return true;
      }
      if (rows.length === 0) return false;
      if (event.key === "ArrowUp") {
        setSelectedIndex((selectedIndex + rows.length - 1) % rows.length);
        return true;
      }
      if (event.key === "ArrowDown") {
        setSelectedIndex((selectedIndex + 1) % rows.length);
        return true;
      }
      if (event.key === "Enter") {
        select(selectedIndex);
        return true;
      }
      return false;
    },
  }));

  if (rows.length === 0) {
    return (
      <div className="w-[238px] rounded-md border border-black/[0.08] bg-surface-raised px-2.5 py-1.5 text-[12px] text-ink-muted shadow-[0_10px_22px_rgba(0,0,0,0.09),0_1px_5px_rgba(0,0,0,0.05)]">
        No matches
      </div>
    );
  }

  return (
    <div
      role="listbox"
      className="w-[238px] overflow-hidden rounded-md border border-black/[0.08] bg-surface-raised p-1 shadow-[0_10px_22px_rgba(0,0,0,0.09),0_1px_5px_rgba(0,0,0,0.05)]"
    >
      {activeKind && normalizedQuery.length === 0 && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setActiveKind(null);
            setSelectedIndex(0);
          }}
          className="mb-0.5 flex h-6 w-full items-center gap-1 rounded px-1.5 text-left text-[11.5px] font-medium text-ink-muted hover:bg-surface-hover/70"
        >
          <ChevronLeft size={12} strokeWidth={1.9} />
          {kindLabel(activeKind)}
        </button>
      )}
      {rows.map((row, index) => {
        const Icon = row.type === "category" ? row.icon : row.item.icon;
        const active = index === selectedIndex;
        const kind = row.type === "category" ? row.kind : row.item.kind;
        const previous = rows[index - 1];
        const previousKind = previous?.type === "category" ? previous.kind : previous?.item.kind;
        const showHeading = normalizedQuery.length > 0 && (!previous || previousKind !== kind);
        return (
          <div key={row.type === "category" ? row.kind : row.item.mentionId}>
            {showHeading && (
              <div className="px-1.5 pb-0.5 pt-1 text-[9.5px] font-medium uppercase text-ink-subtle">
                {kindLabel(kind)}
              </div>
            )}
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(index)}
              onMouseEnter={() => setSelectedIndex(index)}
              role="option"
              aria-selected={active}
              className={`flex min-h-[38px] w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors duration-150 ${
                active ? "bg-surface-hover text-ink" : "text-ink/90 hover:bg-surface-hover/70"
              }`}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-black/[0.07] bg-surface/70 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.65)]">
                <Icon size={12.5} strokeWidth={1.85} className="text-ink-muted" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[12px] font-medium text-ink">
                  {row.type === "category" ? row.label : row.item.displayLabel}
                </span>
                <span className="truncate text-[10.5px] leading-[1.25] text-ink-subtle">
                  {row.type === "category" ? row.description : row.item.description}
                </span>
              </span>
              {row.type === "category" ? (
                <ChevronRight
                  size={12}
                  strokeWidth={1.9}
                  className="ml-1 shrink-0 text-ink-subtle"
                />
              ) : (
                <>
                  {row.item.needsSetup && (
                    <span className="ml-1 shrink-0 rounded-[4px] border border-warning-border bg-warning-bg px-1 py-0.5 text-[9.5px] font-medium text-warning">
                      Needs setup
                    </span>
                  )}
                  <span className="ml-1 shrink-0 rounded-[4px] bg-surface-subtle px-1 py-0.5 text-[9.5px] font-medium text-ink-subtle">
                    {row.item.kind}
                  </span>
                </>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
});

function kindLabel(kind: AgentMentionItem["kind"]) {
  if (kind === "model") return "Models";
  if (kind === "tool") return "Tools";
  if (kind === "agent") return "Agents";
  if (kind === "integration") return "Work integrations";
  if (kind === "schedule") return "Schedules";
  if (kind === "hook") return "Hooks";
  if (kind === "skill") return "Skills";
  return "Brain";
}

function mentionCommandItem(item: AgentMentionItem) {
  if (item.kind === "schedule") {
    return { id: item.mentionId, label: item.label, action: "schedule" };
  }

  // The "add skill" sentinel opens a dialog instead of inserting a pill.
  if (item.kind === "skill" && item.id === ADD_SKILL_MENTION_ID) {
    return { id: item.mentionId, label: item.label, action: "add-skill" };
  }

  return {
    id: item.mentionId,
    label: item.label,
    ...(item.kind === "integration" && item.fullName ? { fullName: item.fullName } : {}),
    ...(item.kind === "integration" && item.defaultBranch
      ? { defaultBranch: item.defaultBranch }
      : {}),
    ...(item.kind === "integration" && item.binding ? { binding: item.binding } : {}),
  };
}
