export function SessionStatusDot({ status, pulse = false }: { status: string; pulse?: boolean }) {
  // For non-pulse (SessionView): keep existing span-based dot with halo
  if (!pulse) {
    const tone =
      status === "failed"
        ? "bg-[#dc2626] shadow-[0_0_0_2px_rgba(220,38,38,0.1)]"
        : status === "running" || status === "provisioning"
          ? "bg-[#16a34a] shadow-[0_0_0_2px_rgba(22,163,74,0.12)]"
          : status === "aborting" || status === "archiving"
            ? "bg-[#d97706] shadow-[0_0_0_2px_rgba(217,119,6,0.11)]"
            : "bg-ink-subtle/45";
    return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />;
  }

  // For pulse (Sidebar): SVG circle stays perfectly round at small sizes
  const fill =
    status === "failed"
      ? "#dc2626"
      : status === "running" || status === "provisioning"
        ? "#16a34a"
        : status === "aborting" || status === "archiving"
          ? "#d97706"
          : "#9a9a96";

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
