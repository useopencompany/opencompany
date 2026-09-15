import { CornerDownRight } from "lucide-react";

// A message the user pushed into this turn while it was already running. It renders at the point
// the engine received it, so the transcript explains why the turn changed direction mid-flight.

export function SteeringItem({ text }: { text: string }) {
  return (
    <div
      data-testid="chat-steering-item"
      className="flex max-w-[92%] items-start gap-2 self-start rounded-lg border border-border border-dashed bg-surface px-2.5 py-1.5"
    >
      <CornerDownRight size={13} strokeWidth={1.8} className="mt-0.5 shrink-0 text-ink-subtle" />
      <span className="min-w-0 whitespace-pre-wrap text-[12.5px] leading-5 text-ink-muted">
        {text}
      </span>
    </div>
  );
}
