"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { updateAgent } from "@/lib/agents/actions";
import { AgentEditor } from "@/components/agent-editor/AgentEditor";

type Props = {
  id: string;
  initialName: string;
  initialBody: string;
  initialGitHubSyncStatus: string;
  initialGitHubSyncError: string | null;
};

type SaveState = "idle" | "saving" | "saved";

export default function AgentDetail({
  id,
  initialName,
  initialBody,
  initialGitHubSyncStatus,
  initialGitHubSyncError,
}: Props) {
  const [name, setName] = useState(initialName);
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [githubSyncStatus, setGitHubSyncStatus] = useState(initialGitHubSyncStatus);
  const [githubSyncError, setGitHubSyncError] = useState(initialGitHubSyncError);
  const pendingRef = useRef<{ name?: string; body?: string }>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = () => {
    const patch = { ...pendingRef.current };
    if (!patch.name && patch.body === undefined) return;
    pendingRef.current = {};
    setSaveState("saving");
    setGitHubSyncStatus("pending");
    setGitHubSyncError(null);
    startTransition(async () => {
      await updateAgent(id, patch);
      setSaveState("saved");
      router.refresh();
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
          <div className="flex items-center gap-2 tabular-nums text-ink-subtle">
            <span>
              {saveState === "saving"
                ? "Saving..."
                : saveState === "saved"
                  ? "Saved"
                  : ""}
            </span>
            <span title={githubSyncError ?? undefined}>
              {githubSyncStatus === "pending"
                ? "Syncing to GitHub"
                : githubSyncStatus === "syncing"
                  ? "Syncing to GitHub"
                  : githubSyncStatus === "failed"
                    ? "GitHub sync failed"
                    : githubSyncStatus === "synced"
                      ? "Synced"
                      : ""}
            </span>
          </div>
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
            initialBody={initialBody}
            onChange={(body) => {
              pendingRef.current.body = body;
              schedule();
            }}
          />
        </div>
      </div>
    </main>
  );
}
