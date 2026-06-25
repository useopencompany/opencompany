export function SessionStatusDot({ status, pulse = false }: { status: string; pulse?: boolean }) {
  // For non-pulse (SessionView): keep existing span-based dot with halo
  if (!pulse) {
    const tone =
      status === "failed"
        ? "bg-danger shadow-[0_0_0_2px_rgba(220,38,38,0.1)]"
        : status === "running" || status === "provisioning"
          ? "bg-success shadow-[0_0_0_2px_rgba(22,163,74,0.12)]"
          : status === "awaiting_approval" ||
              status === "awaiting_input" ||
              status === "awaiting_delegation" ||
              status === "interrupted" ||
              status === "aborting" ||
              status === "archiving"
            ? "bg-warning shadow-[0_0_0_2px_rgba(217,119,6,0.11)]"
            : "bg-ink-subtle/45";
    return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />;
  }

  // For pulse (Sidebar): SVG circle stays perfectly round at small sizes
  const fill =
    status === "failed"
      ? "var(--color-danger)"
      : status === "running" || status === "provisioning"
        ? "var(--color-success)"
        : status === "awaiting_approval" ||
            status === "awaiting_input" ||
            status === "awaiting_delegation" ||
            status === "interrupted" ||
            status === "aborting" ||
            status === "archiving"
          ? "var(--color-warning)"
          : "var(--color-ink-subtle)";

  const animation = status === "running" || status === "provisioning" ? "session-pulse" : "";

  return (
    <svg
      viewBox="0 0 10 10"
      className={`inline-block h-3 w-3 shrink-0 ${animation}`}
      aria-hidden="true"
    >
      <circle cx="5" cy="5" r="3.5" fill={fill} />
    </svg>
  );
}
