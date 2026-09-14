import { cn } from "@opencompany/ui/lib/utils";

// Workflows and Skills share one activation model, so draft/active reads the same everywhere: a
// filled dot for active, a faint one for draft.
export function StatusDot({
  status,
  className,
}: {
  status: "draft" | "active";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        status === "active" ? "bg-success" : "bg-ink-faint",
        className,
      )}
    />
  );
}
