export function SessionStatusDot({ status, pulse = false }: { status: string; pulse?: boolean }) {
  const tone =
    status === "failed"
      ? pulse
        ? "bg-[#dc2626]"
        : "bg-[#dc2626] shadow-[0_0_0_2px_rgba(220,38,38,0.1)]"
      : status === "running" || status === "provisioning"
        ? pulse
          ? "bg-[#16a34a]"
          : "bg-[#16a34a] shadow-[0_0_0_2px_rgba(22,163,74,0.12)]"
        : status === "aborting" || status === "archiving"
          ? pulse
            ? "bg-[#d97706]"
            : "bg-[#d97706] shadow-[0_0_0_2px_rgba(217,119,6,0.11)]"
          : "bg-ink-subtle/45";

  const animation =
    pulse && (status === "running" || status === "provisioning") ? "session-pulse" : "";

  return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone} ${animation}`} />;
}
