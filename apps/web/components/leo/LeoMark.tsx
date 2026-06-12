// Leo's mark: two rounded capsules with dot "eyes" resting top-right — a
// minimal, personal sign that someone's in there. Drawn on a 24x24 grid with
// 2px strokes so it scales from a 14px sidebar chip to a hero lockup.
//
// `animated` makes the eyes tour the capsules (top-right → down-left →
// down-right → back) via the `leo-gaze-tour` keyframes in globals.css; the
// animation is wrapped in prefers-reduced-motion there. Color flows through
// `currentColor` by default, so `className="text-ink"` just works.
export function LeoMark({
  size = 20,
  color = "currentColor",
  animated = false,
  className,
}: {
  size?: number;
  color?: string;
  animated?: boolean;
  className?: string | undefined;
}) {
  const eye = animated ? { animation: "leo-gaze-tour 5.5s ease-in-out infinite" } : undefined;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={className}
    >
      <rect x="2.2" y="4" width="8.4" height="16" rx="4.2" stroke={color} strokeWidth={2} />
      <rect x="13.4" y="4" width="8.4" height="16" rx="4.2" stroke={color} strokeWidth={2} />
      <circle cx="7.6" cy="9.2" r="2.7" fill={color} style={eye} />
      <circle cx="18.8" cy="9.2" r="2.7" fill={color} style={eye} />
    </svg>
  );
}
