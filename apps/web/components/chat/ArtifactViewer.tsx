"use client";

import type { PublishedChatArtifact } from "@opencompany/agent-runtime";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Markdown } from "@/components/Markdown";

export type ArtifactSelection = {
  artifact: PublishedChatArtifact;
  href: string;
};

export function ArtifactViewer({ selection }: { selection: ArtifactSelection }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas" data-testid="artifact-viewer">
      <ArtifactPreview key={selection.href} artifact={selection.artifact} href={selection.href} />
    </div>
  );
}

function ArtifactPreview({ artifact, href }: { artifact: PublishedChatArtifact; href: string }) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const markdownPreview = artifact.mediaType === "text/markdown";

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

  if (isInlineMediaType(artifact.mediaType)) {
    return (
      <iframe
        src={href}
        title={`${artifact.title} preview`}
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
