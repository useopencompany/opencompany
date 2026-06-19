"use client";

import { useEffect, useRef, useState } from "react";
import {
  type GestureMode,
  gestureModeFor,
  lockAxis,
  progressFor,
  shouldCommitOpen,
} from "./drawerGesture";

type Options = {
  open: boolean;
  setOpen: (v: boolean) => void;
  isMobile: boolean;
  /** Measures the live drawer width (px) for progress; falls back when unmeasured. */
  getWidth: () => number;
};

/**
 * Drives the existing off-canvas drawer with a finger drag: edge-swipe to open,
 * drag-left to close, tracking the pointer 1:1. Returns `dragging` + `progress`
 * (0 closed → 1 open) so the shell can apply a live transform and fade the scrim.
 *
 * Listens on `document` so the open-edge, the drawer and the scrim all feed one
 * handler; gated by `isMobile` so desktop is completely untouched. Decision logic
 * lives in `drawerGesture.ts`.
 */
export function useDrawerGesture({ open, setOpen, isMobile, getWidth }: Options): {
  dragging: boolean;
  progress: number;
} {
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);

  // Keep the latest props available to the once-bound listeners without re-binding.
  const latest = useRef({ open, setOpen, getWidth });
  useEffect(() => {
    latest.current = { open, setOpen, getWidth };
  });

  useEffect(() => {
    if (!isMobile) return;

    let mode: GestureMode | null = null;
    let axis: "x" | "y" | null = null;
    let pointerId = -1;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastT = 0;
    let velocity = 0;
    let width = 1;

    const end = () => {
      mode = null;
      axis = null;
      pointerId = -1;
      setDragging(false);
    };

    const onDown = (e: PointerEvent) => {
      if (mode !== null) return; // already tracking a pointer
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const next = gestureModeFor(latest.current.open, e.clientX);
      if (!next) return;
      mode = next;
      pointerId = e.pointerId;
      startX = lastX = e.clientX;
      startY = e.clientY;
      lastT = e.timeStamp;
      velocity = 0;
      width = latest.current.getWidth() || 1;
    };

    const onMove = (e: PointerEvent) => {
      if (mode === null || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (axis === null) {
        const locked = lockAxis(dx, dy);
        if (!locked) return;
        if (locked === "y") return end(); // vertical → let the page scroll
        axis = "x";
        setDragging(true);
      }
      e.preventDefault();
      const dt = e.timeStamp - lastT;
      if (dt > 0) velocity = (e.clientX - lastX) / dt;
      lastX = e.clientX;
      lastT = e.timeStamp;
      setProgress(progressFor(mode, dx, width));
    };

    const onUp = (e: PointerEvent) => {
      if (mode === null || e.pointerId !== pointerId) return;
      if (axis === "x") {
        const p = progressFor(mode, e.clientX - startX, width);
        latest.current.setOpen(shouldCommitOpen(mode, p, velocity));
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

  return { dragging, progress };
}
