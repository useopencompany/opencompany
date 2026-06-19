"use client";

import { useEffect, useRef, useState } from "react";
import {
  type DrawerSide,
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
 * Finger-driven swipe for a left nav drawer and an optional right panel. Edge-swipe
 * to open the side you started from, drag to close whichever is open — one at a time.
 * Listens on `document` so the edges, drawers and scrim all feed one handler; gated by
 * `isMobile` so desktop is untouched. Decision logic lives in `drawerGesture.ts`.
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

    let start: { side: DrawerSide; opening: boolean } | null = null;
    let axis: "x" | "y" | null = null;
    let pid = -1;
    let sx = 0;
    let sy = 0;
    let lx = 0;
    let lt = 0;
    let vel = 0;
    let width = 1;

    const end = () => {
      start = null;
      axis = null;
      pid = -1;
      setActive(null);
    };

    const onDown = (e: PointerEvent) => {
      if (start !== null) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const { left: L, right: R } = latest.current;
      const g = resolveGesture(
        { leftOpen: L.isOpen(), rightOpen: R?.isOpen() ?? false, rightAvailable: !!R },
        e.clientX,
        window.innerWidth,
      );
      if (!g) return;
      start = g;
      pid = e.pointerId;
      sx = lx = e.clientX;
      sy = e.clientY;
      lt = e.timeStamp;
      vel = 0;
      width = (g.side === "left" ? L.getWidth() : (R?.getWidth() ?? 0)) || 1;
    };

    const onMove = (e: PointerEvent) => {
      if (!start || e.pointerId !== pid) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (axis === null) {
        const locked = lockAxis(dx, dy);
        if (!locked) return;
        if (locked === "y") return end(); // vertical → let the page scroll
        axis = "x";
      }
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
      if (!start || e.pointerId !== pid) return;
      if (axis === "x") {
        const dx = e.clientX - sx;
        const p = progressForSide(start.side, start.opening, dx, width);
        const open = shouldCommitOpen(start.side, start.opening, p, vel);
        (start.side === "left" ? latest.current.left : latest.current.right)?.setOpen(open);
      }
      end();
    };

    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp, { passive: true });
    document.addEventListener("pointercancel", onUp, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, [isMobile]);

  return {
    left: active?.side === "left" ? { dragging: true, progress: active.progress } : IDLE,
    right: active?.side === "right" ? { dragging: true, progress: active.progress } : IDLE,
  };
}
