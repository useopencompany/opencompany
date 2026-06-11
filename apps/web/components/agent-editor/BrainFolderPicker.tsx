"use client";

import { FileText, Folder, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentBrainMention } from "./tools";

type Props = {
  brainItems: AgentBrainMention[];
  onSelect: (item: AgentBrainMention) => void;
  onClose: () => void;
};

/**
 * Mac-Finder-style popup for browsing the brain file tree.
 * Rendered as a fixed overlay so it escapes the tippy mention-list container.
 * Opened via the "Browse folders" button inside the Brain category of MentionList.
 */
export function BrainFolderPicker({ brainItems, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const normalizedQuery = query.trim().toLowerCase();

  const filteredItems = useMemo(() => {
    if (!normalizedQuery) return brainItems;
    return brainItems.filter(
      (item) =>
        item.path.toLowerCase().includes(normalizedQuery) ||
        item.displayLabel.toLowerCase().includes(normalizedQuery),
    );
  }, [brainItems, normalizedQuery]);

  const clampedIndex = Math.min(selectedIndex, Math.max(0, filteredItems.length - 1));

  // Auto-focus the search input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelectorAll("[role='option']")[clampedIndex];
    active?.scrollIntoView({ block: "nearest" });
  }, [clampedIndex]);

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, filteredItems.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = filteredItems[clampedIndex];
      if (item) {
        onSelect(item);
      }
    }
  }

  return (
    // Backdrop — clicking outside dismisses the picker
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[15vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[340px] overflow-hidden rounded-xl border border-black/[0.1] bg-surface-raised shadow-[0_20px_60px_rgba(0,0,0,0.18),0_4px_16px_rgba(0,0,0,0.08)]"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Search size={13} strokeWidth={1.9} className="shrink-0 text-ink-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search brain folders..."
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-subtle/60"
          />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClose}
            className="shrink-0 rounded p-0.5 text-ink-subtle hover:bg-surface-hover/70 hover:text-ink"
            aria-label="Close folder picker"
          >
            <X size={13} strokeWidth={1.9} />
          </button>
        </div>

        {/* File tree list */}
        <div
          ref={listRef}
          role="listbox"
          aria-label="Brain folders"
          className="max-h-[280px] overflow-y-auto p-1"
        >
          {filteredItems.length === 0 ? (
            <div className="px-2.5 py-4 text-center text-[12px] text-ink-muted">No matches</div>
          ) : (
            filteredItems.map((item, index) => {
              const isFolder = item.path.endsWith("/") || item.path === "";
              const Icon = isFolder ? Folder : FileText;
              const active = index === clampedIndex;
              // Indent based on path depth (trailing slash = folder, so strip it for counting)
              const depth = item.path.replace(/\/$/, "").split("/").filter(Boolean).length;
              return (
                <button
                  key={item.mentionId}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onSelect(item)}
                  onMouseEnter={() => setSelectedIndex(index)}
                  style={{ paddingLeft: `${6 + depth * 14}px` }}
                  className={`flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left transition-colors duration-100 ${
                    active ? "bg-surface-hover text-ink" : "text-ink/90 hover:bg-surface-hover/70"
                  }`}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                    <Icon size={12} strokeWidth={1.85} className="text-ink-muted" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                    {item.displayLabel}
                  </span>
                  {isFolder && (
                    <span className="shrink-0 rounded-[3px] bg-surface-subtle px-1 py-0.5 text-[9.5px] font-medium text-ink-subtle">
                      folder
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="border-t border-border px-3 py-2 text-[10.5px] text-ink-subtle">
          {filteredItems.length} {filteredItems.length === 1 ? "result" : "results"} ·{" "}
          <span className="font-medium">↵</span> to select ·{" "}
          <span className="font-medium">esc</span> to close
        </div>
      </div>
    </div>
  );
}
