import { describe, expect, it } from "vitest";
import { lockAxis, progressForSide, resolveGesture, shouldCommitOpen } from "./drawerGesture";

const closed = { leftOpen: false, rightOpen: false, rightAvailable: true };

describe("resolveGesture (filmstrip: [ menu | chat | details ])", () => {
  describe("leftward swipe (right-to-left) — steps toward DETAILS", () => {
    it("opens the right details panel when nothing is open and details exist", () => {
      expect(resolveGesture(closed, -1)).toEqual({ side: "right", opening: true });
    });

    it("does nothing when there is no details panel (e.g. not in a chat)", () => {
      expect(resolveGesture({ ...closed, rightAvailable: false }, -1)).toBeNull();
    });

    it("closes the menu when the menu is open", () => {
      expect(resolveGesture({ ...closed, leftOpen: true }, -1)).toEqual({
        side: "left",
        opening: false,
      });
    });

    it("does nothing when details are already open (already at the right end)", () => {
      expect(resolveGesture({ ...closed, rightOpen: true }, -1)).toBeNull();
    });
  });

  describe("rightward swipe (left-to-right) — steps toward MENU", () => {
    it("opens the menu when nothing is open", () => {
      expect(resolveGesture(closed, 1)).toEqual({ side: "left", opening: true });
    });

    it("opens the menu even when there is no details panel", () => {
      expect(resolveGesture({ ...closed, rightAvailable: false }, 1)).toEqual({
        side: "left",
        opening: true,
      });
    });

    it("closes details when the details panel is open", () => {
      expect(resolveGesture({ ...closed, rightOpen: true }, 1)).toEqual({
        side: "right",
        opening: false,
      });
    });

    it("does nothing when the menu is already open (already at the left end)", () => {
      expect(resolveGesture({ ...closed, leftOpen: true }, 1)).toBeNull();
    });
  });

  it("the position the swipe starts from is irrelevant — only direction decides", () => {
    // Same state + direction always resolves the same way regardless of where it began.
    expect(resolveGesture(closed, -1)).toEqual({ side: "right", opening: true });
    expect(resolveGesture(closed, 1)).toEqual({ side: "left", opening: true });
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
