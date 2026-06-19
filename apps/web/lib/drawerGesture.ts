/**
 * Pure decision logic for the mobile drawer swipe gesture. Kept free of React and
 * the DOM so the feel — edge zone, axis lock, snap threshold, flick velocity — is
 * unit-testable in isolation. `useDrawerGesture` wires these to pointer events.
 *
 * Values tuned on a real device (see docs/superpowers/specs/2026-06-18-mobile-swipe-drawer-design.md).
 */
export const DRAWER_GESTURE = {
  /** px-wide catch zone on the left where an open-drag may begin. */
  EDGE: 140,
  /** fraction of drawer width past which a release commits to the new state. */
  THRESHOLD: 0.4,
  /** px/ms flick speed that commits regardless of distance dragged. */
  VELOCITY: 0.5,
  /** px of movement before the gesture commits to a horizontal or vertical axis. */
  SLOP: 8,
} as const;

export type GestureMode = "open" | "close";

/**
 * Which drag (if any) a `pointerdown` starts: an open-drag only when the drawer is
 * closed and the touch begins within the left edge zone; a close-drag from anywhere
 * while it is open.
 */
export function gestureModeFor(
  open: boolean,
  startX: number,
  edge = DRAWER_GESTURE.EDGE,
): GestureMode | null {
  if (open) return "close";
  return startX <= edge ? "open" : null;
}

/**
 * Lock the gesture to an axis once movement passes the slop threshold. A vertical
 * lock means the caller should bail so the page scrolls normally.
 */
export function lockAxis(dx: number, dy: number, slop = DRAWER_GESTURE.SLOP): "x" | "y" | null {
  if (Math.abs(dx) < slop && Math.abs(dy) < slop) return null;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

/** Open progress (0 = closed, 1 = fully open) for a horizontal delta, clamped. */
export function progressFor(mode: GestureMode, dx: number, width: number): number {
  const raw = mode === "open" ? dx / width : 1 + dx / width;
  return Math.max(0, Math.min(1, raw));
}

/**
 * Final open state on release. An open-drag commits open past the distance threshold
 * or on a fast right flick; a close-drag stays open unless it was dragged most of the
 * way closed or flicked left.
 */
export function shouldCommitOpen(
  mode: GestureMode,
  progress: number,
  velocity: number,
  threshold = DRAWER_GESTURE.THRESHOLD,
  flick = DRAWER_GESTURE.VELOCITY,
): boolean {
  if (mode === "open") return progress > threshold || velocity > flick;
  return !(progress < 1 - threshold || velocity < -flick);
}
