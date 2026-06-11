"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { saveSkill } from "@/lib/skills/actions";

export type AddedSkill = {
  id: string;
  name: string;
  description: string;
  source: PreviewSkill["source"];
};

type Candidate = { path: string; name: string; description: string };

type PreviewSkill = {
  skillId: string;
  name: string;
  description: string;
  source: { type: "github" | "skills.sh"; url: string; ref: string; path: string };
  resolvedCommit: string;
  fileCount: number;
  totalBytes: number;
  files: Array<{ path: string }>;
};

type Props = {
  // The dialog is mounted only while open (parent renders it conditionally), so state starts
  // fresh on each open without a reset effect.
  onClose: () => void;
  onAdded: (skill: AddedSkill) => void;
};

function sourceTypeLabel(type: PreviewSkill["source"]["type"]) {
  return type === "skills.sh" ? "skills.sh via GitHub" : "GitHub";
}

export function AddSkillDialog({ onClose, onAdded }: Props) {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "resolving" | "adding">("idle");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewSkill | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && status === "idle") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [status, onClose]);

  const busy = status !== "idle";

  async function resolve(selectedPath?: string) {
    setStatus("resolving");
    setError(null);
    try {
      const response = await fetch("/api/skills/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, ...(selectedPath !== undefined ? { selectedPath } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(typeof data.error === "string" ? data.error : "Couldn't resolve that skill.");
        setPreview(null);
        setCandidates(null);
        return;
      }
      if (data.status === "ambiguous") {
        setCandidates(data.candidates as Candidate[]);
        setPreview(null);
        return;
      }
      setPreview(data.skill as PreviewSkill);
      setCandidates(null);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setStatus("idle");
    }
  }

  async function add() {
    if (!preview) return;
    setStatus("adding");
    setError(null);
    try {
      // Save the exact source we previewed, never the live input — the field may have changed
      // since "Resolve" and we must persist what the user is looking at.
      const result = await saveSkill({
        url: preview.source.url,
        selectedPath: preview.source.path,
      });
      if (result.status !== "saved") {
        setError(result.status === "error" ? result.message : "Couldn't add that skill.");
        return;
      }
      onAdded({
        id: result.skill.id,
        name: result.skill.name,
        description: result.skill.description,
        source: result.skill.source,
      });
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setStatus("idle");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/35 px-4 py-6"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-skill-title"
        className="flex max-h-[calc(100vh-48px)] w-full max-w-[560px] flex-col overflow-hidden rounded-lg border border-black/[0.1] bg-surface-raised shadow-[0_24px_64px_rgba(0,0,0,0.22),0_4px_14px_rgba(0,0,0,0.12)]"
      >
        <div className="border-b border-black/[0.08] px-4 py-3">
          <h2
            id="add-skill-title"
            className="flex items-center gap-1.5 text-[14px] font-semibold text-ink"
          >
            <Sparkles size={14} strokeWidth={1.9} className="text-ink-muted" />
            Add skill from GitHub or skills.sh
          </h2>
        </div>

        <div className="space-y-3 overflow-y-auto px-4 py-4">
          <div>
            <input
              ref={inputRef}
              type="text"
              value={url}
              onChange={(e) => {
                // Editing the URL invalidates any resolved preview/candidates, so the dialog
                // can't add a source that no longer matches what's in the field.
                setUrl(e.target.value);
                setPreview(null);
                setCandidates(null);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && url.trim() && !busy) resolve();
              }}
              placeholder="https://github.com/owner/repo or https://skills.sh/owner/repo/skill"
              disabled={busy}
              className="h-9 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-subtle/70 focus:border-ink/30 disabled:opacity-65"
            />
            <p className="mt-1.5 text-[11.5px] leading-4 text-ink-subtle">
              Paste a public GitHub repository URL or a skills.sh skill page. The skill is
              snapshotted and tracks its branch.
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-danger-border bg-danger-bg px-2.5 py-2 text-[12px] text-danger">
              {error}
            </div>
          )}

          {candidates && (
            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-ink">
                This repository has several skills. Pick one:
              </p>
              <div className="max-h-[200px] space-y-1 overflow-y-auto">
                {candidates.map((candidate) => (
                  <button
                    key={candidate.path}
                    type="button"
                    onClick={() => resolve(candidate.path)}
                    disabled={busy}
                    className="flex w-full flex-col rounded-md border border-border bg-surface px-2.5 py-1.5 text-left hover:bg-surface-muted disabled:opacity-65"
                  >
                    <span className="text-[12.5px] font-medium text-ink">{candidate.name}</span>
                    <span className="truncate text-[11px] text-ink-subtle">
                      {candidate.description}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {preview && (
            <div className="space-y-2 rounded-md border border-border bg-surface px-3 py-2.5">
              <div>
                <div className="text-[13px] font-semibold text-ink">{preview.name}</div>
                <div className="text-[12px] leading-4 text-ink-muted">{preview.description}</div>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
                <dt className="text-ink-subtle">Source</dt>
                <dd className="min-w-0 truncate text-ink-muted">
                  <span className="text-ink">{sourceTypeLabel(preview.source.type)}</span>
                  <span className="text-ink-subtle"> · </span>
                  {preview.source.url}
                  {preview.source.path ? `/${preview.source.path}` : ""}
                </dd>
                <dt className="text-ink-subtle">Ref</dt>
                <dd className="text-ink-muted">
                  {preview.source.ref} @ {preview.resolvedCommit.slice(0, 7)}
                </dd>
                <dt className="text-ink-subtle">Mounts as</dt>
                <dd className="text-ink-muted">@skill/{preview.skillId}</dd>
                <dt className="text-ink-subtle">Files</dt>
                <dd className="text-ink-muted">
                  {preview.fileCount} files · {Math.max(1, Math.round(preview.totalBytes / 1024))}{" "}
                  KB
                </dd>
              </dl>
              <div className="border-t border-border-subtle pt-2">
                <div className="mb-1 text-[11.5px] font-medium text-ink-subtle">Included files</div>
                <ul className="max-h-[128px] space-y-0.5 overflow-y-auto rounded-md bg-surface-muted px-2 py-1.5">
                  {preview.files.map((file) => (
                    <li
                      key={file.path}
                      className="truncate font-mono text-[11px] leading-4 text-ink-muted"
                      title={file.path}
                    >
                      {file.path}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-black/[0.08] px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-8 items-center rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-65"
          >
            Cancel
          </button>
          {preview ? (
            <button
              type="button"
              onClick={add}
              disabled={busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink/15 bg-ink px-3 text-[12.5px] font-medium text-surface hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-65"
            >
              {status === "adding" ? (
                <Loader2 size={13} strokeWidth={1.9} className="animate-spin" />
              ) : (
                <Sparkles size={13} strokeWidth={1.9} />
              )}
              {status === "adding" ? "Adding…" : "Add skill"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => resolve()}
              disabled={busy || !url.trim()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink/15 bg-ink px-3 text-[12.5px] font-medium text-surface hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-65"
            >
              {status === "resolving" ? (
                <Loader2 size={13} strokeWidth={1.9} className="animate-spin" />
              ) : null}
              {status === "resolving" ? "Resolving…" : "Resolve"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
