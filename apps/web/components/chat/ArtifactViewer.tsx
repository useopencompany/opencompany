"use client";

import type { PublishedChatArtifact } from "@opencompany/agent-runtime";
import { Download, ExternalLink, FileText, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Markdown } from "@/components/Markdown";

export type ArtifactSelection = {
  artifact: PublishedChatArtifact;
  href: string;
};

type ArtifactVersion = {
  artifactVersionId: string;
  version: number;
  title: string;
  description?: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  createdAt?: string;
};

export function ArtifactViewer({ selection }: { selection: ArtifactSelection }) {
  const initialVersion = useMemo(() => versionFromSelection(selection), [selection]);
  const [versions, setVersions] = useState<ArtifactVersion[]>([initialVersion]);
  const [selectedVersionId, setSelectedVersionId] = useState(initialVersion.artifactVersionId);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const fallback = versionFromSelection(selection);
    void fetch(`/v1/chat-artifacts/${encodeURIComponent(selection.artifact.artifactId)}/versions`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Version history could not be loaded.");
        const parsed = parseVersionList(await response.json(), selection.artifact.artifactId);
        if (!parsed.length) throw new Error("No artifact versions were returned.");
        setVersions(parsed);
        setSelectedVersionId((current) =>
          parsed.some((version) => version.artifactVersionId === current)
            ? current
            : (parsed[0]?.artifactVersionId ?? fallback.artifactVersionId),
        );
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setHistoryError(error instanceof Error ? error.message : "Version history is unavailable.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false);
      });
    return () => controller.abort();
  }, [selection]);

  const selected =
    versions.find((version) => version.artifactVersionId === selectedVersionId) ?? initialVersion;
  const href =
    selected.artifactVersionId === selection.artifact.artifactVersionId
      ? selection.href
      : artifactVersionHref(selection.artifact.artifactId, selected.artifactVersionId);
  const downloadHref = `${href}?download=1`;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas" data-testid="artifact-viewer">
      <div className="shrink-0 border-b border-border bg-surface px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-ink-muted">
            <FileText size={16} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[13.5px] font-semibold text-ink">{selected.title}</h2>
            <p className="mt-0.5 truncate text-[11.5px] text-ink-subtle">
              {selected.filename} · {formatBytes(selected.sizeBytes)}
            </p>
          </div>
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${selected.title} in a new tab`}
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-subtle hover:bg-surface-hover hover:text-ink"
          >
            <ExternalLink size={15} aria-hidden="true" />
          </a>
          <a
            href={downloadHref}
            aria-label={`Download ${selected.title}`}
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-subtle hover:bg-surface-hover hover:text-ink"
          >
            <Download size={15} aria-hidden="true" />
          </a>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <label htmlFor="artifact-version" className="text-[11.5px] font-medium text-ink-muted">
            Version
          </label>
          <select
            id="artifact-version"
            aria-label="Artifact version"
            value={selected.artifactVersionId}
            onChange={(event) => setSelectedVersionId(event.target.value)}
            disabled={historyLoading || versions.length < 2}
            className="h-8 min-w-0 rounded-md border border-border bg-canvas px-2 text-[12px] text-ink outline-none disabled:opacity-60"
          >
            {versions.map((version) => (
              <option key={version.artifactVersionId} value={version.artifactVersionId}>
                v{version.version}
                {version.createdAt ? ` · ${formatDate(version.createdAt)}` : ""}
              </option>
            ))}
          </select>
          {historyLoading ? (
            <LoaderCircle
              size={13}
              className="animate-spin text-ink-subtle"
              aria-label="Loading versions"
            />
          ) : null}
          {historyError ? <span className="text-[11px] text-danger">{historyError}</span> : null}
        </div>
        {selected.description ? (
          <p className="mt-2 text-[12px] leading-5 text-ink-muted">{selected.description}</p>
        ) : null}
      </div>
      <ArtifactVersionPreview key={selected.artifactVersionId} version={selected} href={href} />
    </div>
  );
}

function ArtifactVersionPreview({ version, href }: { version: ArtifactVersion; href: string }) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const markdownPreview = version.mediaType === "text/markdown";

  useEffect(() => {
    if (!markdownPreview) return;
    const controller = new AbortController();
    void fetch(href, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("This version could not be opened.");
        setMarkdown(await response.text());
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "This version could not be opened.");
        }
      });
    return () => controller.abort();
  }, [href, markdownPreview]);

  if (markdownPreview) {
    if (error) return <PreviewNotice title="Preview unavailable" detail={error} />;
    if (markdown === null) return <PreviewNotice title="Opening artifact…" busy />;
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-7">
        <Markdown content={markdown} className="mx-auto max-w-[760px]" />
      </div>
    );
  }

  if (isInlineMediaType(version.mediaType)) {
    return (
      <iframe
        src={href}
        title={`${version.title} preview`}
        referrerPolicy="no-referrer"
        className="min-h-0 flex-1 bg-white"
      />
    );
  }

  return (
    <PreviewNotice
      title="Preview not available"
      detail="Download this file to open it in its native application."
    />
  );
}

function PreviewNotice({
  title,
  detail,
  busy = false,
}: {
  title: string;
  detail?: string;
  busy?: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
      <div className="flex max-w-xs flex-col items-center gap-2">
        {busy ? <LoaderCircle size={18} className="animate-spin text-ink-subtle" /> : null}
        <p className="text-[13px] font-medium text-ink">{title}</p>
        {detail ? <p className="text-[12px] leading-5 text-ink-subtle">{detail}</p> : null}
      </div>
    </div>
  );
}

function versionFromSelection(selection: ArtifactSelection): ArtifactVersion {
  return {
    artifactVersionId: selection.artifact.artifactVersionId,
    version: selection.artifact.version,
    title: selection.artifact.title,
    ...(selection.artifact.description ? { description: selection.artifact.description } : {}),
    filename: selection.artifact.filename,
    mediaType: selection.artifact.mediaType,
    sizeBytes: selection.artifact.sizeBytes,
  };
}

function parseVersionList(value: unknown, artifactId: string): ArtifactVersion[] {
  if (!isRecord(value) || !isRecord(value.data) || value.data.artifactId !== artifactId) return [];
  if (!Array.isArray(value.data.versions)) return [];
  return value.data.versions.filter(isArtifactVersion);
}

function isArtifactVersion(value: unknown): value is ArtifactVersion {
  if (!isRecord(value)) return false;
  return (
    typeof value.artifactVersionId === "string" &&
    typeof value.version === "number" &&
    Number.isSafeInteger(value.version) &&
    value.version > 0 &&
    typeof value.title === "string" &&
    typeof value.filename === "string" &&
    typeof value.mediaType === "string" &&
    typeof value.sizeBytes === "number" &&
    (value.description === undefined || typeof value.description === "string") &&
    (value.createdAt === undefined || typeof value.createdAt === "string")
  );
}

function artifactVersionHref(artifactId: string, artifactVersionId: string) {
  return `/v1/chat-artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(artifactVersionId)}`;
}

function isInlineMediaType(mediaType: string) {
  return (
    mediaType.startsWith("image/") ||
    mediaType === "application/pdf" ||
    mediaType === "text/csv" ||
    mediaType === "text/tab-separated-values" ||
    mediaType === "text/plain" ||
    mediaType === "application/json"
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10 * 1_024 ? 1 : 0)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
