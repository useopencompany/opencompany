"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { updateAgent } from "@/lib/agents/actions";
import type { TiptapDoc } from "@/lib/db/schema";
import { AgentEditor } from "@/components/agent-editor/AgentEditor";

type Props = {
  id: string;
  initialName: string;
  initialContent: TiptapDoc;
};

type SaveState = "idle" | "saving" | "saved";

export default function AgentDetail({ id, initialName, initialContent }: Props) {
  const [name, setName] = useState(initialName);
  const [, startTransition] = useTransition();
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const pendingRef = useRef<{ name?: string; content?: TiptapDoc }>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = () => {
    const patch = pendingRef.current;
    if (!patch.name && !patch.content) return;
    pendingRef.current = {};
    setSaveState("saving");
    startTransition(async () => {
      await updateAgent(id, patch);
      setSaveState("saved");
    });
  };

  const schedule = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, 600);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[680px] px-6 pb-24 pt-10">
        <div className="flex items-center justify-between text-[12px] text-ink-muted">
          <Link
            href="/agents"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-[#ececea]/70"
          >
            <ChevronLeft size={12} strokeWidth={1.9} />
            Agents
          </Link>
          <span className="tabular-nums text-ink-subtle">
            {saveState === "saving"
              ? "Saving…"
              : saveState === "saved"
                ? "Saved"
                : ""}
          </span>
        </div>

        <input
          value={name}
          onChange={(e) => {
            const next = e.target.value;
            setName(next);
            pendingRef.current.name = next;
            schedule();
          }}
          onBlur={() => {
            if (timerRef.current) clearTimeout(timerRef.current);
            flush();
          }}
          placeholder="Untitled agent"
          className="mt-6 w-full bg-transparent text-[24px] font-semibold tracking-[-0.01em] text-ink outline-none placeholder:text-ink-subtle/60"
        />

        <div className="mt-6">
          <AgentEditor
            initialContent={initialContent}
            onChange={(doc) => {
              pendingRef.current.content = doc;
              schedule();
            }}
          />
        </div>
      </div>
    </main>
  );
}
