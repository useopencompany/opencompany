"use client";

/**
 * Placeholder pane content — renders the session id + name only. The real
 * integration swaps this for the full `SessionView` transcript.
 */
export function SessionPane({
  sessionId,
  sessionName,
}: {
  sessionId: string;
  sessionName?: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <span className="text-sm font-medium text-ink">{sessionName ?? "Untitled session"}</span>
      <code className="rounded-md bg-surface-subtle px-2 py-1 font-mono text-[11px] text-ink-muted">
        {sessionId}
      </code>
    </div>
  );
}
