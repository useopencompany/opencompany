/**
 * Pure decision logic for the mobile drawer swipe — now two-sided: a LEFT nav
 * drawer and an optional RIGHT panel (session details). Kept free of React and
 * the DOM so the feel is unit-testable; `useDrawerGesture` wires it to pointers.
 *
 * Behaviour was tuned on a real device against a prototype (see
 * docs/superpowers/specs/2026-06-18-mobile-swipe-drawer-design.md):
 *  - left edge → right opens the left drawer; drag left to close
 *  - right edge → left opens the right panel (when available); drag right to close
 *  - only one is open at a time
 */
export const DRAWER_GESTURE = {
  /** px-wide catch zone on each edge where an open-drag may begin. */
  EDGE: 140,
  /** fraction of drawer width past which a release commits to the new state. */
  THRESHOLD: 0.4,
  /** px/ms flick speed that commits regardless of distance dragged. */
  VELOCITY: 0.5,
  /** px of movement before the gesture commits to a horizontal or vertical axis. */
  SLOP: 8,
} as const;

export type DrawerSide = "left" | "right";
export type GestureStart = { side: DrawerSide; opening: boolean };

type DrawerState = { leftOpen: boolean; rightOpen: boolean; rightAvailable: boolean };

/**
 * Which drag (if any) a `pointerdown` begins. If a drawer is already open, the
 * touch starts closing it (from anywhere). Otherwise an edge touch opens the
 * drawer on that side — the right side only when it's available (i.e. in a chat).
 */
export function resolveGesture(
  state: DrawerState,
  startX: number,
  viewportWidth: number,
  edge = DRAWER_GESTURE.EDGE,
): GestureStart | null {
  if (state.leftOpen) return { side: "left", opening: false };
  if (state.rightOpen) return { side: "right", opening: false };
  if (startX <= edge) return { side: "left", opening: true };
  if (state.rightAvailable && startX >= viewportWidth - edge)
    return { side: "right", opening: true };
  return null;
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
export function progressForSide(
  side: DrawerSide,
  opening: boolean,
  dx: number,
  width: number,
): number {
  const raw =
    side === "left"
      ? opening
        ? dx / width // left opens dragging right
        : 1 + dx / width // left closes dragging left
      : opening
        ? -dx / width // right opens dragging left
        : 1 - dx / width; // right closes dragging right
  return Math.max(0, Math.min(1, raw));
}

/**
 * Final open state on release. An opening drag commits past the distance
 * threshold or on a fast flick toward the open direction; a closing drag stays
 * open unless dragged most of the way closed or flicked toward closed. Flick
 * direction is mirrored for the right side.
 */
export function shouldCommitOpen(
  side: DrawerSide,
  opening: boolean,
  progress: number,
  velocity: number,
  threshold = DRAWER_GESTURE.THRESHOLD,
  flick = DRAWER_GESTURE.VELOCITY,
): boolean {
  if (opening) {
    const flickOpen = side === "left" ? velocity > flick : velocity < -flick;
    return progress > threshold || flickOpen;
  }
  const flickClose = side === "left" ? velocity < -flick : velocity > flick;
  return !(progress < 1 - threshold || flickClose);
}
