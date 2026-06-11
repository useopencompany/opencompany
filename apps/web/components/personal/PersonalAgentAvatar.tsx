// The personal agent's visual identity: a small gradient disc with the agent's initial. Violet on
// purpose — the user's own avatar (SidebarAccountFooter / ProfileAvatar) is blue, so the two
// identities stay visually distinct wherever they appear side by side.
export function PersonalAgentAvatar({
  name,
  size = 14,
  className = "",
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white ring-1 ring-black/[0.08] ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.54),
        background: "radial-gradient(circle at 30% 30%, #e3dbff 0%, #7c5cf0 40%, #170b33 85%)",
      }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}
