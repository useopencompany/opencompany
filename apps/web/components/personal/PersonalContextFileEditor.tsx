"use client";

import { Check, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { useToast } from "@/components/ToastProvider";
import type { AgentBundleFilePayload } from "@/lib/agents/bundle-files";
import {
  createPersonalAgentContextFile,
  updatePersonalAgentContextFile,
} from "@/lib/personal/actions";

type SaveState = "idle" | "saving" | "saved";

// A plain monospace editor for a single file in the personal agent's bundle. Two modes:
//  - editing an existing file: relativePath is fixed, content auto-saves on a debounce.
//  - creating a new file: the user names it (prefilled with the folder prefix) and hits Create.
// Both write through local-only server actions (no GitHub sync) scoped to the personal agent.
export function PersonalContextFileEditor({
  agentId,
  bundleDir,
  file,
  newFilePrefix,
  onSaved,
  onCreated,
}: {
  agentId: string;
  bundleDir: string | null;
  // Present when editing; absent when creating a new file.
  file?: AgentBundleFilePayload;
  // The folder path a new file should default into (e.g. "memory/", "skills/", "files/").
  newFilePrefix?: string;
  onSaved: (file: AgentBundleFilePayload) => void;
  onCreated: (file: AgentBundleFilePayload) => void;
}) {
  if (file) {
    return (
      <ExistingFileEditor
        key={file.path}
        agentId={agentId}
        bundleDir={bundleDir}
        file={file}
        onSaved={onSaved}
      />
    );
  }
  return (
    <NewFileEditor
      agentId={agentId}
      bundleDir={bundleDir}
      prefix={newFilePrefix ?? ""}
      onCreated={onCreated}
    />
  );
}

function ExistingFileEditor({
  agentId,
  bundleDir,
  file,
  onSaved,
}: {
  agentId: string;
  bundleDir: string | null;
  file: AgentBundleFilePayload;
  onSaved: (file: AgentBundleFilePayload) => void;
}) {
  const { showError } = useToast();
  const [content, setContent] = useState(file.content);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [, startTransition] = useTransition();
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = () => {
    const next = pendingRef.current;
    if (next === null) return;
    pendingRef.current = null;
    setSaveState("saving");
    startTransition(async () => {
      try {
        const result = await updatePersonalAgentContextFile(agentId, file.relativePath, next);
        if (!result.ok) {
          setSaveState("idle");
          showError(result.error, "Could not save file");
          return;
        }
        onSaved(result.file);
        setSaveState("saved");
      } catch (error) {
        setSaveState("idle");
        showError(
          error instanceof Error ? error.message : "Could not save file",
          "Could not save file",
        );
      }
    });
  };

  const schedule = (next: string) => {
    pendingRef.current = next;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, 600);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className="mx-auto flex h-full w-full max-w-[760px] flex-col px-6 py-10">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-[17px] font-semibold tracking-[-0.01em] text-ink">
            {fileName(file.relativePath)}
          </h1>
          <p className="mt-1 truncate font-mono text-[12px] text-ink-muted">
            {bundleDir ? `${bundleDir}/${file.relativePath}` : file.relativePath}
          </p>
        </div>
        <SaveIndicator state={saveState} />
      </div>

      <textarea
        value={content}
        onChange={(event) => {
          setContent(event.target.value);
          setSaveState("idle");
          schedule(event.target.value);
        }}
        onBlur={flush}
        spellCheck={false}
        className="mt-6 min-h-0 flex-1 resize-none rounded-lg border border-border bg-surface/40 px-4 py-3 font-mono text-[13px] leading-6 text-ink outline-none focus:border-ink/25 focus:bg-canvas"
        placeholder="Empty file"
      />
    </div>
  );
}

function NewFileEditor({
  agentId,
  bundleDir,
  prefix,
  onCreated,
}: {
  agentId: string;
  bundleDir: string | null;
  prefix: string;
  onCreated: (file: AgentBundleFilePayload) => void;
}) {
  const { showError } = useToast();
  const [path, setPath] = useState(prefix);
  const [content, setContent] = useState("");
  const [isPending, startTransition] = useTransition();
  const nameRef = useRef<HTMLInputElement>(null);

  // Drop focus past the prefilled folder prefix so the user types the name straight away.
  useEffect(() => {
    const el = nameRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const trimmed = path.trim();
  const canCreate = Boolean(trimmed) && !trimmed.endsWith("/") && !isPending;

  const create = () => {
    if (!canCreate) return;
    startTransition(async () => {
      try {
        const result = await createPersonalAgentContextFile(agentId, trimmed, content);
        if (!result.ok) {
          showError(result.error, "Could not create file");
          return;
        }
        onCreated(result.file);
      } catch (error) {
        showError(
          error instanceof Error ? error.message : "Could not create file",
          "Could not create file",
        );
      }
    });
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-[760px] flex-col px-6 py-10">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[13px]">
          {bundleDir && <span className="shrink-0 text-ink-muted">{bundleDir}/</span>}
          <input
            ref={nameRef}
            value={path}
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                create();
              }
            }}
            placeholder="notes.md"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-border bg-surface/40 px-2.5 py-1.5 text-ink outline-none focus:border-ink/25 focus:bg-canvas"
          />
        </div>
        <button
          type="button"
          onClick={create}
          disabled={!canCreate}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-ink px-3 py-1.5 text-[12.5px] font-medium text-canvas transition-colors duration-150 hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPending ? <LoaderCircle size={12} strokeWidth={2} className="animate-spin" /> : null}
          Create
        </button>
      </div>

      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        spellCheck={false}
        className="mt-6 min-h-0 flex-1 resize-none rounded-lg border border-border bg-surface/40 px-4 py-3 font-mono text-[13px] leading-6 text-ink outline-none focus:border-ink/25 focus:bg-canvas"
        placeholder="Empty file"
      />
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === "saving") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-ink-subtle">
        <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />
        Saving…
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-ink-subtle">
        <Check size={12} strokeWidth={2} />
        Saved
      </span>
    );
  }
  return null;
}

function fileName(relativePath: string) {
  return relativePath.split("/").filter(Boolean).at(-1) ?? relativePath;
}
