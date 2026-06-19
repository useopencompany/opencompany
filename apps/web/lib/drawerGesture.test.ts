import { describe, expect, it } from "vitest";
import {
  DRAWER_GESTURE,
  gestureModeFor,
  lockAxis,
  progressFor,
  shouldCommitOpen,
} from "./drawerGesture";

describe("gestureModeFor", () => {
  it("starts an open-drag when closed and the touch begins inside the edge zone", () => {
    expect(gestureModeFor(false, 10)).toBe("open");
    expect(gestureModeFor(false, DRAWER_GESTURE.EDGE)).toBe("open");
  });

  it("does not start when closed and the touch begins beyond the edge zone", () => {
    expect(gestureModeFor(false, DRAWER_GESTURE.EDGE + 1)).toBeNull();
    expect(gestureModeFor(false, 999)).toBeNull();
  });

  it("starts a close-drag from anywhere when the drawer is open", () => {
    expect(gestureModeFor(true, 5)).toBe("close");
    expect(gestureModeFor(true, 999)).toBe("close");
  });
});

describe("lockAxis", () => {
  it("stays unlocked until movement passes the slop threshold", () => {
    expect(lockAxis(3, 2)).toBeNull();
  });

  it("locks horizontal when the drag is mostly sideways", () => {
    expect(lockAxis(20, 5)).toBe("x");
  });

  it("locks vertical when the drag is mostly up/down (so the page can scroll)", () => {
    expect(lockAxis(5, 20)).toBe("y");
  });
});

describe("progressFor", () => {
  it("maps an open-drag to 0..1 across the drawer width", () => {
    expect(progressFor("open", 150, 300)).toBeCloseTo(0.5);
  });

  it("clamps an open-drag to [0, 1]", () => {
    expect(progressFor("open", 450, 300)).toBe(1);
    expect(progressFor("open", -30, 300)).toBe(0);
  });

  it("maps a close-drag (dragging left from open) down from 1", () => {
    expect(progressFor("close", -150, 300)).toBeCloseTo(0.5);
    expect(progressFor("close", 0, 300)).toBe(1);
  });
});

describe("shouldCommitOpen", () => {
  it("opens when an open-drag passes the distance threshold", () => {
    expect(shouldCommitOpen("open", 0.5, 0)).toBe(true);
  });

  it("falls back closed when an open-drag is too short and slow", () => {
    expect(shouldCommitOpen("open", 0.2, 0)).toBe(false);
  });

  it("opens on a fast right flick even if the distance is short", () => {
    expect(shouldCommitOpen("open", 0.1, 0.7)).toBe(true);
  });

  it("closes when a close-drag passes the distance threshold", () => {
    expect(shouldCommitOpen("close", 0.5, 0)).toBe(false);
  });

  it("stays open when a close-drag is too short and slow", () => {
    expect(shouldCommitOpen("close", 0.8, 0)).toBe(true);
  });

  it("closes on a fast left flick even if the drawer is still mostly open", () => {
    expect(shouldCommitOpen("close", 0.9, -0.7)).toBe(false);
  });
});
