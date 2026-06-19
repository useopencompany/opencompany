import { describe, expect, it } from "vitest";
import {
  DRAWER_GESTURE,
  lockAxis,
  progressForSide,
  resolveGesture,
  shouldCommitOpen,
} from "./drawerGesture";

const VW = 400;
const closed = { leftOpen: false, rightOpen: false, rightAvailable: true };

describe("resolveGesture", () => {
  it("starts an open-drag for the LEFT drawer from the left edge zone", () => {
    expect(resolveGesture(closed, 10, VW)).toEqual({ side: "left", opening: true });
    expect(resolveGesture(closed, DRAWER_GESTURE.EDGE, VW)).toEqual({
      side: "left",
      opening: true,
    });
  });

  it("starts an open-drag for the RIGHT drawer from the right edge zone when available", () => {
    expect(resolveGesture(closed, VW - 10, VW)).toEqual({ side: "right", opening: true });
  });

  it("does not start a right-drag when the right drawer is unavailable (e.g. not in a chat)", () => {
    expect(resolveGesture({ ...closed, rightAvailable: false }, VW - 10, VW)).toBeNull();
  });

  it("ignores touches that start in the middle (so the page scrolls/taps normally)", () => {
    expect(resolveGesture(closed, VW / 2, VW)).toBeNull();
  });

  it("starts a close-drag for whichever drawer is open, from anywhere", () => {
    expect(resolveGesture({ ...closed, leftOpen: true }, VW / 2, VW)).toEqual({
      side: "left",
      opening: false,
    });
    expect(resolveGesture({ ...closed, rightOpen: true }, 5, VW)).toEqual({
      side: "right",
      opening: false,
    });
  });
});

describe("lockAxis", () => {
  it("stays unlocked under the slop threshold", () => expect(lockAxis(3, 2)).toBeNull());
  it("locks horizontal when mostly sideways", () => expect(lockAxis(20, 5)).toBe("x"));
  it("locks vertical when mostly up/down", () => expect(lockAxis(5, 20)).toBe("y"));
});

describe("progressForSide", () => {
  it("left opens as you drag right, closes as you drag left", () => {
    expect(progressForSide("left", true, 150, 300)).toBeCloseTo(0.5);
    expect(progressForSide("left", false, -150, 300)).toBeCloseTo(0.5);
  });
  it("right opens as you drag left, closes as you drag right", () => {
    expect(progressForSide("right", true, -150, 300)).toBeCloseTo(0.5);
    expect(progressForSide("right", false, 150, 300)).toBeCloseTo(0.5);
  });
  it("clamps to [0,1]", () => {
    expect(progressForSide("left", true, 999, 300)).toBe(1);
    expect(progressForSide("right", true, 30, 300)).toBe(0);
  });
});

describe("shouldCommitOpen", () => {
  it("left: opens past threshold, or on a fast right flick", () => {
    expect(shouldCommitOpen("left", true, 0.5, 0)).toBe(true);
    expect(shouldCommitOpen("left", true, 0.1, 0.7)).toBe(true);
    expect(shouldCommitOpen("left", true, 0.2, 0)).toBe(false);
  });
  it("right: opens past threshold, or on a fast LEFT flick", () => {
    expect(shouldCommitOpen("right", true, 0.5, 0)).toBe(true);
    expect(shouldCommitOpen("right", true, 0.1, -0.7)).toBe(true);
    expect(shouldCommitOpen("right", true, 0.1, 0)).toBe(false);
  });
  it("left close: stays open unless dragged most of the way or flicked left", () => {
    expect(shouldCommitOpen("left", false, 0.8, 0)).toBe(true);
    expect(shouldCommitOpen("left", false, 0.5, 0)).toBe(false);
    expect(shouldCommitOpen("left", false, 0.9, -0.7)).toBe(false);
  });
  it("right close: stays open unless dragged most of the way or flicked right", () => {
    expect(shouldCommitOpen("right", false, 0.8, 0)).toBe(true);
    expect(shouldCommitOpen("right", false, 0.5, 0)).toBe(false);
    expect(shouldCommitOpen("right", false, 0.9, 0.7)).toBe(false);
  });
});
