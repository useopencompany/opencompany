import { Button } from "@opencompany/ui/components/button";

// Shown in place of a silent empty transcript when the Electric message sync fails. The stream keeps
// retrying in the background (see the collection onError), so this is a non-blocking nudge: Retry
// clears the flag and re-preloads.
export function ChatTranscriptSyncError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2.5"
    >
      <p className="text-[13px] leading-5 text-ink">We couldn&apos;t load this conversation.</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
