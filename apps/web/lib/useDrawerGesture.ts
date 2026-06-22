"use client";

import { useEffect, useRef, useState } from "react";
import {
  type DrawerSide,
  type GestureStart,
  lockAxis,
  progressForSide,
  resolveGesture,
  shouldCommitOpen,
} from "./drawerGesture";

/** One swipeable drawer. `isOpen` is read live (the right panel's state lives elsewhere). */
export type DrawerSideConfig = {
  isOpen: () => boolean;
  setOpen: (open: boolean) => void;
  /** Live drawer width in px, for progress math; the hook falls back to 1 if unmeasured. */
  getWidth: () => number;
};

type Options = {
  isMobile: boolean;
  left: DrawerSideConfig;
  /** Omit/null when no right panel exists on this page (e.g. not in a chat). */
  right: DrawerSideConfig | null;
};

export type DragState = { dragging: boolean; progress: number };
const IDLE: DragState = { dragging: false, progress: 0 };

/**
 * Finger-driven swipe modeled as a horizontal filmstrip `[ MENU | CHAT | DETAILS ]`:
 * a leftward swipe steps toward details (close menu, else open the right panel), a
 * rightward swipe steps toward the menu (close details, else open the left drawer).
 * Decision logic — including the mutual exclusion that keeps menu and details from
 * ever showing together — lives in `drawerGesture.ts`.
 *
 * Listens on `document` in the CAPTURE phase so the swipe still fires even when a child
 * stops pointer-event propagation (chat widgets, menus). Which drawer a swipe drives is
 * resolved at axis-lock from the drag DIRECTION, not the pointer-down position, so a
 * swipe can start anywhere on the surface. Gated by `isMobile` so desktop is untouched.
 *
 * Returns live `{ dragging, progress }` per side so the shell can apply a 1:1 transform
 * (the right side's values are forwarded to the registered panel via the bridge context).
 */
export function useDrawerGesture({ isMobile, left, right }: Options): {
  left: DragState;
  right: DragState;
} {
  const [active, setActive] = useState<{ side: DrawerSide; progress: number } | null>(null);
  const latest = useRef({ left, right });
  useEffect(() => {
    latest.current = { left, right };
  });

  useEffect(() => {
    if (!isMobile) return;

    // Captured at pointer-down; the side/intent is only resolved once the gesture locks
    // to the horizontal axis and its direction is known.
    let snapshot: { leftOpen: boolean; rightOpen: boolean; rightAvailable: boolean } | null = null;
    let start: GestureStart | null = null;
    let axis: "x" | "y" | null = null;
    let pid = -1;
    let sx = 0;
    let sy = 0;
    let lx = 0;
    let lt = 0;
    let vel = 0;
    let width = 1;

    const end = () => {
      snapshot = null;
      start = null;
      axis = null;
      pid = -1;
      setActive(null);
    };

    const onDown = (e: PointerEvent) => {
      if (snapshot || start) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const { left: L, right: R } = latest.current;
      // Snapshot what's open now; the direction (and thus which drawer) comes later.
      snapshot = {
        leftOpen: L.isOpen(),
        rightOpen: R?.isOpen() ?? false,
        rightAvailable: !!R,
      };
      pid = e.pointerId;
      sx = lx = e.clientX;
      sy = e.clientY;
      lt = e.timeStamp;
      vel = 0;
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pid) return;
      if (!snapshot && !start) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (axis === null) {
        const locked = lockAxis(dx, dy);
        if (!locked) return;
        if (locked === "y") return end(); // vertical → let the page scroll
        axis = "x";
        // Direction is known now → decide which drawer this swipe drives.
        const g = snapshot ? resolveGesture(snapshot, dx < 0 ? -1 : 1) : null;
        if (!g) return end(); // nothing to do in this direction → leave the drag to the page
        start = g;
        const { left: L, right: R } = latest.current;
        width = (g.side === "left" ? L.getWidth() : (R?.getWidth() ?? 0)) || 1;
        snapshot = null;
      }
      if (!start) return;
      e.preventDefault();
      const dt = e.timeStamp - lt;
      if (dt > 0) vel = (e.clientX - lx) / dt;
      lx = e.clientX;
      lt = e.timeStamp;
      setActive({
        side: start.side,
        progress: progressForSide(start.side, start.opening, dx, width),
      });
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pid) return;
      if (start && axis === "x") {
        const dx = e.clientX - sx;
        const p = progressForSide(start.side, start.opening, dx, width);
        const open = shouldCommitOpen(start.side, start.opening, p, vel);
        (start.side === "left" ? latest.current.left : latest.current.right)?.setOpen(open);
      }
      end();
    };

    // Capture phase: document sees the event before any descendant, so a child that
    // calls stopPropagation() can't swallow the swipe. pointermove is non-passive so it
    // can preventDefault once the gesture owns the horizontal axis.
    const opts = { capture: true } as const;
    document.addEventListener("pointerdown", onDown, { ...opts, passive: true });
    document.addEventListener("pointermove", onMove, { ...opts, passive: false });
    document.addEventListener("pointerup", onUp, { ...opts, passive: true });
    document.addEventListener("pointercancel", onUp, { ...opts, passive: true });
    return () => {
      document.removeEventListener("pointerdown", onDown, opts);
      document.removeEventListener("pointermove", onMove, opts);
      document.removeEventListener("pointerup", onUp, opts);
      document.removeEventListener("pointercancel", onUp, opts);
    };
  }, [isMobile]);

  return {
    left: active?.side === "left" ? { dragging: true, progress: active.progress } : IDLE,
    right: active?.side === "right" ? { dragging: true, progress: active.progress } : IDLE,
  };
}
