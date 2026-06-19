/**
 * Pure decision logic for the mobile drawer swipe, modeled as a single horizontal
 * "filmstrip": `[ MENU | CHAT | DETAILS ]`, with the chat in the middle. Every swipe is
 * one step along the strip, decided by DIRECTION — not by where the finger starts:
 *
 *   ← right-to-left (leftward): step toward DETAILS — close the menu, else open details
 *   → left-to-right (rightward): step toward MENU — close details, else open the menu
 *
 * Because the menu and the details panel sit at opposite ends, only one is ever open at
 * a time — that mutual exclusion falls out of the model rather than being enforced.
 *
 * Kept free of React and the DOM so the feel is unit-testable; `useDrawerGesture` wires
 * it to pointer events. Behaviour was tuned on a real device against a prototype (see
 * docs/superpowers/specs/2026-06-18-mobile-swipe-drawer-design.md).
 */
export const DRAWER_GESTURE = {
  /** fraction of drawer width past which a release commits to the new state. */
  THRESHOLD: 0.4,
  /** px/ms flick speed that commits regardless of distance dragged. */
  VELOCITY: 0.5,
  /** px of movement before the gesture commits to a horizontal or vertical axis. */
  SLOP: 8,
} as const;

export type DrawerSide = "left" | "right";
/** Horizontal swipe direction: -1 = leftward (right-to-left), 1 = rightward (left-to-right). */
export type SwipeDirection = -1 | 1;
export type GestureStart = { side: DrawerSide; opening: boolean };

type DrawerState = { leftOpen: boolean; rightOpen: boolean; rightAvailable: boolean };

/**
 * Which drag (if any) a horizontal swipe begins, given its direction. The decision is
 * deferred until the gesture has locked to the horizontal axis (so its direction is
 * known) rather than taken at pointer-down — that is what lets a swipe start anywhere
 * on the surface and still do the right thing.
 */
export function resolveGesture(state: DrawerState, direction: SwipeDirection): GestureStart | null {
  if (direction < 0) {
    // leftward → move the strip toward DETAILS
    if (state.leftOpen) return { side: "left", opening: false }; // close the menu
    if (state.rightOpen) return null; // already at the details end — nothing further right
    if (state.rightAvailable) return { side: "right", opening: true }; // open details
    return null; // no details here (e.g. not in a chat) → leave the drag to the page
  }
  // rightward → move the strip toward MENU
  if (state.rightOpen) return { side: "right", opening: false }; // close details
  if (state.leftOpen) return null; // already at the menu end — nothing further left
  return { side: "left", opening: true }; // open the menu
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
