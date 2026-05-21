"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import type { AgentTool } from "./tools";

export type MentionListHandle = {
  onKeyDown: (event: KeyboardEvent) => boolean;
};

type Props = {
  items: AgentTool[];
  command: (item: { id: string; label: string }) => void;
};

export const MentionList = forwardRef<MentionListHandle, Props>(function MentionList(
  { items, command },
  ref,
) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  const select = (index: number) => {
    const item = items[index];
    if (!item) return;
    command({ id: item.id, label: item.label });
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      if (event.key === "ArrowUp") {
        setSelectedIndex((selectedIndex + items.length - 1) % items.length);
        return true;
      }
      if (event.key === "ArrowDown") {
        setSelectedIndex((selectedIndex + 1) % items.length);
        return true;
      }
      if (event.key === "Enter") {
        select(selectedIndex);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-[#e6e6e3] bg-white px-2 py-1.5 text-[12px] text-ink-muted shadow-[0_4px_12px_rgba(15,15,15,0.08)]">
        No matches
      </div>
    );
  }

  return (
    <div className="min-w-[160px] overflow-hidden rounded-md border border-[#e6e6e3] bg-white p-1 shadow-[0_4px_12px_rgba(15,15,15,0.08)]">
      {items.map((item, index) => {
        const Icon = item.icon;
        const active = index === selectedIndex;
        return (
          <button
            key={item.id}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => select(index)}
            onMouseEnter={() => setSelectedIndex(index)}
            className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12.5px] ${
              active ? "bg-[#f1f1ee] text-ink" : "text-ink/85 hover:bg-[#f5f5f1]"
            }`}
          >
            <Icon size={11} strokeWidth={1.9} className="text-ink-muted" />
            <span>{item.label}</span>
            <span className="ml-auto text-[10.5px] text-ink-subtle">tool</span>
          </button>
        );
      })}
    </div>
  );
});
