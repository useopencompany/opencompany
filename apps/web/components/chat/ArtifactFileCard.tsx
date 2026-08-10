"use client";

import type { GoatPublishedChatArtifact } from "@opencompany/agent-runtime";
import { Download, ExternalLink, FileText, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";

export function ArtifactFileCard({
  artifact,
  href,
  readOnly,
}: {
  artifact: GoatPublishedChatArtifact;
  href: string;
  readOnly: boolean;
}) {
  const [locallyDeleted, setLocallyDeleted] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deleted = locallyDeleted || artifact.state === "deleted";
  const downloadHref = `${href}${href.includes("?") ? "&" : "?"}download=1`;

  const deleteArtifact = async () => {
    if (deleted || deleting) return;
    if (!window.confirm(`Delete “${artifact.title}” and all of its versions?`)) return;
    setDeleting(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/chat-artifacts/${encodeURIComponent(artifact.artifactId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("File deletion failed.");
      setLocallyDeleted(true);
    } catch {
      setError("Could not delete this file. Try again.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="flex max-w-[92%] items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
      data-testid="artifact-file-card"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-ink-muted">
        <FileText size={17} strokeWidth={1.8} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium leading-tight text-ink">
          {artifact.title}
        </div>
        <div className="mt-0.5 truncate text-[11.5px] leading-tight text-ink-subtle">
          {deleted
            ? "File deleted"
            : `${artifact.filename} · ${formatBytes(artifact.sizeBytes)} · v${artifact.version}`}
        </div>
        {error ? <div className="mt-1 text-[11px] text-danger">{error}</div> : null}
      </div>
      {!deleted ? (
        <div className="flex shrink-0 items-center gap-0.5">
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${artifact.title}`}
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <ExternalLink size={15} strokeWidth={1.9} aria-hidden="true" />
          </a>
          <a
            href={downloadHref}
            aria-label={`Download ${artifact.title}`}
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <Download size={15} strokeWidth={1.9} aria-hidden="true" />
          </a>
          {!readOnly ? (
            <button
              type="button"
              onClick={deleteArtifact}
              disabled={deleting}
              aria-label={`Delete ${artifact.title}`}
              className="flex h-8 w-8 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-danger/10 hover:text-danger focus:outline-none focus-visible:ring-1 focus-visible:ring-danger/30 disabled:opacity-50"
            >
              {deleting ? (
                <Loader2 size={15} className="animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 size={15} strokeWidth={1.9} aria-hidden="true" />
              )}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10 * 1_024 ? 1 : 0)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}
